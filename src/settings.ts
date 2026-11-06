import { App, Notice, PluginSettingTab, Setting, setIcon } from "obsidian";
import { runGoogleNetworkDiagnostics } from "./auth";
import type DriveVaultSyncPlugin from "./main";
import { requestManualBackupName, showBackupRestoreModal } from "./modals";
import { progressPercent } from "./progress";
import { BackupMeta, DEFAULT_SETTINGS } from "./types";

const OAUTH_GUIDE_STEPS = [
  "Open console.cloud.google.com and create a project (any name).",
  "APIs & Services → Library: search for “Google Drive API” and enable it.",
  "APIs & Services → OAuth consent screen: choose “External”, fill in the app name and your e-mail, and add your Google account under “Test users”.",
  "APIs & Services → Credentials → Create credentials → OAuth client ID.",
  "Application type: “TVs and Limited Input devices” (not “Web application”).",
  "Copy the Client ID and the Client secret into the fields below."
];

export class DriveVaultSyncSettingTab extends PluginSettingTab {
  private statusCardEl?: HTMLElement;

  constructor(app: App, private plugin: DriveVaultSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("dvs-settings");
    this.plugin.onConnectionChange = () => this.display();
    this.plugin.onStatusChange = () => this.renderStatusCard();

    const connected = this.plugin.getStoredAuth() !== undefined;
    this.statusCardEl = containerEl.createDiv("dvs-status-card");
    this.renderStatusCard();

    if (!connected) {
      this.renderSetup(containerEl);
    } else if (!this.plugin.isInitialSyncCompleted()) {
      this.renderFirstSync(containerEl);
    }

    if (connected) {
      this.renderSyncSection(containerEl);
      this.renderBackupSection(containerEl);
      this.renderDeviceSection(containerEl);
    }
    this.renderAdvancedSection(containerEl, connected);
    if (connected) this.renderDangerZone(containerEl);
  }

  hide(): void {
    this.plugin.onConnectionChange = undefined;
    this.plugin.onStatusChange = undefined;
    this.statusCardEl = undefined;
  }

  // -------------------------------------------------------------------------
  // Status card
  // -------------------------------------------------------------------------

  private renderStatusCard() {
    const card = this.statusCardEl;
    if (!card) return;
    card.empty();
    const connected = this.plugin.getStoredAuth() !== undefined;
    const status = this.plugin.pluginData.syncStatus;
    const progress = this.plugin.syncEngine?.getProgress();
    const failures = this.plugin.getSyncFailures().length;
    const syncing = progress?.active === true;
    const state = !connected ? "disconnected" : syncing ? "syncing" : status?.state === "error" ? "error" : "idle";

    card.className = `dvs-status-card is-${state}`;
    const icon = card.createDiv("dvs-status-icon");
    setIcon(icon, state === "syncing" ? "refresh-cw" : state === "error" ? "alert-circle" : state === "disconnected" ? "cloud-off" : "cloud");
    if (syncing) icon.addClass("dvs-spin");

    const body = card.createDiv("dvs-status-body");
    let title: string;
    let subtitle: string;
    if (!connected) {
      title = "Not connected";
      subtitle = "Connect your Google account below to start syncing this vault.";
    } else if (syncing && progress) {
      title = `${progress.operation}… ${progressPercent(progress)}%`;
      subtitle = progress.stageDetail;
    } else if (!this.plugin.isInitialSyncCompleted()) {
      title = "Connected — choose how to start";
      subtitle = this.plugin.accountLabel ?? "Pick the first sync direction below.";
    } else if (state === "error") {
      title = "The last sync failed";
      subtitle = status?.lastError ?? "Open the sync log for details.";
    } else {
      title = failures > 0 ? `Synced, but ${failures} file${failures === 1 ? "" : "s"} failed` : "Everything is synced";
      subtitle = [
        this.plugin.accountLabel,
        status?.lastFinishedAt ? `last sync ${describeTime(status.lastFinishedAt)}` : "not synced yet"
      ].filter(Boolean).join(" · ");
    }
    body.createDiv({ cls: "dvs-status-title", text: title });
    body.createDiv({ cls: "dvs-status-subtitle", text: subtitle });
    if (syncing && progress) {
      const bar = body.createDiv("dvs-progress-bar dvs-progress-bar-small");
      bar.createDiv("dvs-progress-bar-fill").setCssProps({ "--dvs-progress": `${progressPercent(progress)}%` });
    } else if (connected && status?.lastSummary && this.plugin.isInitialSyncCompleted()) {
      const summary = status.lastSummary;
      const parts = [
        summary.uploads ? `${summary.uploads} uploaded` : "",
        summary.downloads ? `${summary.downloads} downloaded` : "",
        summary.localDeletes + summary.remoteDeletes ? `${summary.localDeletes + summary.remoteDeletes} deleted` : "",
        summary.conflicts ? `${summary.conflicts} conflicts` : "",
        summary.errors ? `${summary.errors} errors` : ""
      ].filter(Boolean);
      if (parts.length > 0) body.createDiv({ cls: "dvs-status-summary", text: `Last run: ${parts.join(", ")}` });
    }

    const actions = card.createDiv("dvs-status-actions");
    if (connected && this.plugin.isInitialSyncCompleted()) {
      const sync = actions.createEl("button", { text: syncing ? "Show progress" : "Sync now", cls: "mod-cta" });
      sync.addEventListener("click", () => {
        if (syncing) this.plugin.openProgressModal();
        else void this.plugin.syncNow(true);
      });
      if (!syncing) actions.createEl("button", { text: "Progress" }).addEventListener("click", () => this.plugin.openProgressModal());
      if (failures > 0) actions.createEl("button", { text: `Failed files (${failures})`, cls: "mod-warning" }).addEventListener("click", () => this.plugin.openSyncFailuresModal());
      actions.createEl("button", { text: "Sync log" }).addEventListener("click", () => this.plugin.openSyncLogModal());
    }
  }

  // -------------------------------------------------------------------------
  // First-time setup
  // -------------------------------------------------------------------------

  private renderSetup(containerEl: HTMLElement) {
    new Setting(containerEl).setName("Connect Google Drive").setHeading();
    containerEl.createEl("p", {
      cls: "dvs-intro",
      text: "Your notes are stored in your own Google Drive, in a folder only this plugin can access. Google requires every user to create a free “OAuth client” once — it takes about five minutes."
    });

    const guide = containerEl.createEl("details", { cls: "dvs-guide" });
    guide.createEl("summary", { text: "Step 1 — Create a Google OAuth client (step-by-step guide)" });
    const list = guide.createEl("ol");
    for (const step of OAUTH_GUIDE_STEPS) list.createEl("li", { text: step });
    guide.createEl("p", { cls: "dvs-muted", text: "Access is limited to files this plugin creates (scope drive.file) — it cannot see the rest of your Google Drive." });

    new Setting(containerEl)
      .setName("Step 2 — Client ID")
      .setDesc("Looks like 1234567890-abc….apps.googleusercontent.com")
      .addText((text) => text
        .setPlaceholder("Client ID")
        .setValue(this.plugin.settings.clientId)
        .onChange(async (value) => {
          this.plugin.settings.clientId = value.trim();
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName("Client secret")
      .setDesc("Stored only in this vault's plugin data.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("Client secret")
          .setValue(this.plugin.settings.clientSecret)
          .onChange(async (value) => {
            this.plugin.settings.clientSecret = value.trim();
            await this.plugin.saveSettings();
          });
      });
    new Setting(containerEl)
      .setName("Step 3 — Sign in with Google")
      .setDesc("Opens Google in your browser and shows a short code to confirm.")
      .addButton((button) => button.setButtonText("Connect").setCta().onClick(async () => {
        if (!this.plugin.settings.clientId || !this.plugin.settings.clientSecret) {
          new Notice("Enter the Client ID and Client secret first.");
          return;
        }
        try {
          await this.plugin.connectGoogleDrive();
          this.display();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "Could not connect Google Drive.");
        }
      }));
    containerEl.createEl("p", {
      cls: "dvs-muted",
      text: "Already set up on another device? Open these settings there, choose “Sign in on another device” and scan the QR code with this device's camera."
    });
  }

  private renderFirstSync(containerEl: HTMLElement) {
    new Setting(containerEl).setName("Start syncing").setHeading();
    containerEl.createEl("p", { cls: "dvs-intro", text: "This is a one-time choice for this device. Automatic sync stays paused until you choose." });
    new Setting(containerEl)
      .setName("Download from Google Drive")
      .setDesc("For a device you are adding to an existing setup. This vault is replaced with the cloud copy — you can keep files that exist only here.")
      .addButton((button) => button.setButtonText("Download").setCta().onClick(() => void this.runFirstSync("cloud-to-local")));
    new Setting(containerEl)
      .setName("Upload this vault")
      .setDesc("For your first device. The cloud copy is replaced with this vault, and other devices follow it.")
      .addButton((button) => button.setButtonText("Upload").setWarning().onClick(() => void this.runFirstSync("local-to-cloud")));
  }

  private async runFirstSync(direction: "cloud-to-local" | "local-to-cloud") {
    try {
      await this.plugin.runInitialSync(direction);
      this.display();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "First sync failed.");
    }
  }

  // -------------------------------------------------------------------------
  // Sync behaviour
  // -------------------------------------------------------------------------

  private renderSyncSection(containerEl: HTMLElement) {
    const settings = this.plugin.settings;
    new Setting(containerEl).setName("Sync").setHeading();

    new Setting(containerEl)
      .setName("Sync when I edit notes")
      .setDesc("Changes are sent a few seconds after you stop typing.")
      .addToggle((toggle) => toggle.setValue(settings.autoSyncEnabled).onChange(async (value) => {
        settings.autoSyncEnabled = value;
        await this.plugin.saveSettings();
        this.plugin.configureTimers();
      }));
    new Setting(containerEl)
      .setName("Wait after an edit")
      .setDesc("Seconds of quiet before an automatic sync starts.")
      .addSlider((slider) => slider
        .setLimits(1, 60, 1)
        .setValue(Math.max(1, settings.syncDebounceSeconds))
        .setDynamicTooltip()
        .onChange(async (value) => {
          settings.syncDebounceSeconds = value;
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName("Sync when Obsidian starts")
      .addToggle((toggle) => toggle.setValue(settings.syncOnStartup).onChange(async (value) => {
        settings.syncOnStartup = value;
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName("Watch for changes from other devices")
      .setDesc("Checks a tiny marker on Google Drive and syncs only when another device changed something.")
      .addToggle((toggle) => toggle.setValue(settings.cloudWatchEnabled).onChange(async (value) => {
        settings.cloudWatchEnabled = value;
        await this.plugin.saveSettings();
        this.plugin.configureTimers();
      }))
      .addDropdown((dropdown) => {
        for (const seconds of [15, 30, 60, 120, 300]) dropdown.addOption(String(seconds), seconds < 60 ? `every ${seconds} s` : `every ${seconds / 60} min`);
        if (!dropdown.selectEl.querySelector(`option[value="${settings.cloudWatchIntervalSeconds}"]`)) {
          dropdown.addOption(String(settings.cloudWatchIntervalSeconds), `every ${settings.cloudWatchIntervalSeconds} s`);
        }
        dropdown.setValue(String(settings.cloudWatchIntervalSeconds)).onChange(async (value) => {
          settings.cloudWatchIntervalSeconds = Math.max(10, Number(value) || DEFAULT_SETTINGS.cloudWatchIntervalSeconds);
          await this.plugin.saveSettings();
          this.plugin.configureTimers();
        });
      });
    new Setting(containerEl)
      .setName("Full check as a safety net")
      .setDesc("Runs a complete sync periodically, even if nothing seemed to change.")
      .addToggle((toggle) => toggle.setValue(settings.fullSyncFallbackEnabled).onChange(async (value) => {
        settings.fullSyncFallbackEnabled = value;
        await this.plugin.saveSettings();
        this.plugin.configureTimers();
      }))
      .addDropdown((dropdown) => {
        for (const minutes of [15, 30, 60, 120, 240]) dropdown.addOption(String(minutes), minutes < 60 ? `every ${minutes} min` : `every ${minutes / 60} h`);
        if (!dropdown.selectEl.querySelector(`option[value="${settings.syncIntervalMinutes}"]`)) {
          dropdown.addOption(String(settings.syncIntervalMinutes), `every ${settings.syncIntervalMinutes} min`);
        }
        dropdown.setValue(String(settings.syncIntervalMinutes)).onChange(async (value) => {
          settings.syncIntervalMinutes = Math.max(1, Number(value) || DEFAULT_SETTINGS.syncIntervalMinutes);
          await this.plugin.saveSettings();
          this.plugin.configureTimers();
        });
      });
    new Setting(containerEl)
      .setName("When a note changed on two devices")
      .setDesc("Markdown edits in different parts of a note are always combined automatically. This applies only when they overlap.")
      .addDropdown((dropdown) => dropdown
        .addOption("keep-both", "Ask me (keep both if unsure)")
        .addOption("prefer-local", "Keep this device's version")
        .addOption("prefer-remote", "Keep the cloud version")
        .setValue(settings.conflictPolicy)
        .onChange(async (value) => {
          settings.conflictPolicy = value as typeof settings.conflictPolicy;
          await this.plugin.saveSettings();
        }));
  }

  // -------------------------------------------------------------------------
  // Backups
  // -------------------------------------------------------------------------

  private renderBackupSection(containerEl: HTMLElement) {
    const settings = this.plugin.settings;
    new Setting(containerEl).setName("Backups").setHeading();
    new Setting(containerEl)
      .setName("Back up before overwriting or deleting")
      .setDesc("Keeps the previous version of every file a sync replaces or removes, in Google Drive.")
      .addToggle((toggle) => toggle.setValue(settings.backupEnabled).onChange(async (value) => {
        settings.backupEnabled = value;
        await this.plugin.saveSettings();
        this.display();
      }));
    if (settings.backupEnabled) {
      new Setting(containerEl)
        .setName("How often")
        .setDesc("“Only when needed” backs up risky changes only. “Regularly” also keeps your ordinary edits at most once per interval.")
        .addDropdown((dropdown) => dropdown
          .addOption("safety-only", "Only when needed")
          .addOption("timed", "Regularly")
          .addOption("every-sync", "Every sync")
          .setValue(settings.backupMode)
          .onChange(async (value) => {
            settings.backupMode = value as typeof settings.backupMode;
            await this.plugin.saveSettings();
            this.display();
          }));
      if (settings.backupMode === "timed") {
        new Setting(containerEl)
          .setName("Regular backup interval")
          .addDropdown((dropdown) => {
            for (const minutes of [15, 30, 60, 180, 720, 1440]) dropdown.addOption(String(minutes), minutes < 60 ? `${minutes} min` : `${minutes / 60} h`);
            if (!dropdown.selectEl.querySelector(`option[value="${settings.backupIntervalMinutes}"]`)) {
              dropdown.addOption(String(settings.backupIntervalMinutes), `${settings.backupIntervalMinutes} min`);
            }
            dropdown.setValue(String(settings.backupIntervalMinutes)).onChange(async (value) => {
              settings.backupIntervalMinutes = Math.max(1, Number(value) || DEFAULT_SETTINGS.backupIntervalMinutes);
              await this.plugin.saveSettings();
            });
          });
      }
      new Setting(containerEl)
        .setName("Automatic backups to keep")
        .setDesc("Older automatic backups are deleted. Manual backups are never deleted automatically.")
        .addSlider((slider) => slider
          .setLimits(1, 50, 1)
          .setValue(settings.maxBackups)
          .setDynamicTooltip()
          .onChange(async (value) => {
            settings.maxBackups = value;
            await this.plugin.saveSettings();
          }));
    }

    new Setting(containerEl)
      .setName("Full backup now")
      .setDesc("Uploads a complete, named copy of this vault that is kept until you delete it.")
      .addButton((button) => button.setButtonText("Create backup").onClick(async () => {
        const label = await requestManualBackupName(this.app);
        if (!label) return;
        button.setDisabled(true).setButtonText("Creating…");
        this.plugin.openProgressModal();
        try {
          await this.plugin.createManualBackup(label);
          this.display();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "The backup failed.");
          button.setDisabled(false).setButtonText("Create backup");
        }
      }));

    const browser = containerEl.createEl("details", { cls: "dvs-section-details" });
    browser.createEl("summary", { text: "Browse and restore backups" });
    const manualEl = browser.createDiv();
    const autoEl = browser.createDiv();
    let loaded = false;
    browser.addEventListener("toggle", () => {
      if (!browser.open || loaded) return;
      loaded = true;
      this.renderBackupList(manualEl, "Manual backups", () => this.plugin.getManualBackups(), (backup) => this.plugin.deleteManualBackup(backup));
      this.renderBackupList(autoEl, "Automatic backups", () => this.plugin.getBackups(), (backup) => this.plugin.deleteBackup(backup));
    });
  }

  private renderBackupList(
    container: HTMLElement,
    title: string,
    load: () => Promise<BackupMeta[]>,
    remove: (backup: BackupMeta) => Promise<void>
  ) {
    container.createEl("h4", { text: title, cls: "dvs-subheading" });
    const listEl = container.createDiv("dvs-backup-list");
    listEl.setText("Loading…");
    load().then((backups) => {
      listEl.empty();
      if (backups.length === 0) {
        listEl.createDiv({ cls: "dvs-muted", text: "None yet." });
        return;
      }
      for (const backup of backups) {
        const files = backup.kind === "manual" ? `${backup.changedCount} files` : `${backup.changedCount} changed, ${backup.deletedCount} deleted`;
        new Setting(listEl)
          .setName(backup.label || new Date(backup.createdAt).toLocaleString())
          .setDesc(`${backup.label ? `${new Date(backup.createdAt).toLocaleString()} · ` : ""}${backup.deviceName} · ${files}`)
          .addButton((button) => button.setButtonText("Open").onClick(async () => {
            try {
              button.setDisabled(true).setButtonText("Loading…");
              const data = await this.plugin.drive.loadBackupData(backup.fileId);
              button.setDisabled(false).setButtonText("Open");
              const choice = await showBackupRestoreModal(this.app, backup, data, (fileId) => this.plugin.drive.downloadFile(fileId));
              if (!choice) return;
              this.plugin.openProgressModal();
              if (choice.type === "file") await this.plugin.restoreFileFromBackup(backup, choice.path);
              else await this.plugin.restoreFromBackup(backup);
            } catch (error) {
              button.setDisabled(false).setButtonText("Open");
              new Notice(error instanceof Error ? error.message : "Restore failed.");
            }
          }))
          .addExtraButton((button) => button.setIcon("trash-2").setTooltip("Delete this backup").onClick(async () => {
            try {
              await remove(backup);
              container.empty();
              this.renderBackupList(container, title, load, remove);
            } catch (error) {
              new Notice(error instanceof Error ? error.message : "Could not delete the backup.");
            }
          }));
      }
    }).catch((error) => {
      listEl.setText(error instanceof Error ? error.message : "Could not load backups.");
    });
  }

  // -------------------------------------------------------------------------
  // This device
  // -------------------------------------------------------------------------

  private renderDeviceSection(containerEl: HTMLElement) {
    new Setting(containerEl).setName("This device").setHeading();
    new Setting(containerEl)
      .setName("Device name")
      .setDesc("Shown to your other devices in conflicts and backups.")
      .addText((text) => text
        .setPlaceholder("My laptop")
        .setValue(this.plugin.settings.deviceName)
        .onChange(async (value) => {
          this.plugin.settings.deviceName = value.trim();
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName("Google account")
      .setDesc(this.plugin.accountLabel ?? "Connected")
      .addButton((button) => button.setButtonText("Sign in on another device").onClick(() => this.plugin.showAuthExportModal()))
      .addButton((button) => button.setButtonText("Disconnect").setWarning().onClick(async () => {
        await this.plugin.disconnectGoogleDrive();
        this.display();
      }));
  }

  // -------------------------------------------------------------------------
  // Advanced
  // -------------------------------------------------------------------------

  private renderAdvancedSection(containerEl: HTMLElement, connected: boolean) {
    const settings = this.plugin.settings;
    const details = containerEl.createEl("details", { cls: "dvs-section-details" });
    details.createEl("summary", { text: "Advanced" });

    if (connected) {
      new Setting(details)
        .setName("OAuth client")
        .setDesc(`${settings.clientId ? `Client ID ${settings.clientId.slice(0, 16)}…` : "Not set"}. To use a different client, disconnect and run the setup again.`);
    }
    new Setting(details)
      .setName("Google Drive folder")
      .setDesc("Name of the folder in your Google Drive that holds this vault. Change it only before the first sync, or to start a separate copy.")
      .addText((text) => text.setValue(settings.remoteFolderName).onChange(async (value) => {
        settings.remoteFolderName = value.trim() || DEFAULT_SETTINGS.remoteFolderName;
        await this.plugin.saveSettings();
      }));
    new Setting(details)
      .setName("Excluded paths")
      .setDesc("One file or folder per line (folders end with /). These are never synced.")
      .addTextArea((text) => {
        text.inputEl.rows = 7;
        text.inputEl.addClass("dvs-textarea");
        text.setValue(settings.ignoredPaths).onChange(async (value) => {
          settings.ignoredPaths = value;
          await this.plugin.saveSettings();
        });
      });
    new Setting(details)
      .setName("Deletion safety limit")
      .setDesc("If a sync would delete more than this share of your synced files, it stops and asks first.")
      .addSlider((slider) => slider
        .setLimits(0, 100, 5)
        .setValue(settings.maxDeletionPercent)
        .setDynamicTooltip()
        .onChange(async (value) => {
          settings.maxDeletionPercent = value;
          await this.plugin.saveSettings();
        }));
    new Setting(details)
      .setName("Parallel transfers")
      .setDesc("More is faster on good connections; lower it if Google reports rate limits.")
      .addSlider((slider) => slider
        .setLimits(1, 8, 1)
        .setValue(settings.requestConcurrency)
        .setDynamicTooltip()
        .onChange(async (value) => {
          settings.requestConcurrency = value;
          this.plugin.queue.setConcurrency(value);
          await this.plugin.saveSettings();
        }));
    new Setting(details)
      .setName("Debug logging")
      .setDesc("Writes extra details to the developer console. Tokens and note contents are never logged.")
      .addToggle((toggle) => toggle.setValue(settings.debugMode).onChange(async (value) => {
        settings.debugMode = value;
        await this.plugin.saveSettings();
      }));
    if (connected) {
      new Setting(details)
        .setName("Clean up Google Drive")
        .setDesc("Find leftover duplicate files in the sync folder that no device uses.")
        .addButton((button) => button.setButtonText("Scan").onClick(() => void this.plugin.cleanRemoteDuplicates()));
    }

    const diagnostics = new Setting(details)
      .setName("Connection test")
      .setDesc("Checks that this device can reach Google sign-in and Google Drive.");
    const resultEl = details.createDiv("dvs-diagnostics dvs-hidden");
    diagnostics.addButton((button) => button.setButtonText("Run test").onClick(async () => {
      button.setDisabled(true).setButtonText("Testing…");
      resultEl.removeClass("dvs-hidden");
      resultEl.setText("Testing…");
      try {
        const results = await runGoogleNetworkDiagnostics(settings.clientId, settings.clientSecret);
        resultEl.empty();
        for (const result of results) {
          const item = resultEl.createDiv("dvs-diagnostic-item");
          const ok = result.reachable;
          const head = item.createDiv("dvs-diagnostic-head");
          setIcon(head.createSpan(ok ? "dvs-success-text" : "dvs-error-text"), ok ? "check-circle" : "x-circle");
          head.createSpan({ text: `${result.name} — ${ok ? `reachable (HTTP ${result.status}, ${result.durationMs} ms)` : "unreachable"}` });
          if (result.note) item.createDiv({ cls: "dvs-muted", text: result.note });
          if (!ok && result.error) item.createDiv({ cls: "dvs-error-text", text: result.error });
          if (ok && !result.ok && !result.expectedErrorResponse && result.responseDescription) {
            item.createDiv({ cls: "dvs-muted", text: `Google said: ${result.responseDescription}` });
          }
        }
        const failures = results.filter((result) => !result.reachable).length;
        new Notice(failures === 0 ? "Google is reachable from this device." : `${failures} Google service${failures === 1 ? " is" : "s are"} unreachable from this device.`);
      } catch (error) {
        resultEl.setText(error instanceof Error ? error.message : "The test failed.");
      } finally {
        button.setDisabled(false).setButtonText("Run test");
      }
    }));
  }

  // -------------------------------------------------------------------------
  // Danger zone
  // -------------------------------------------------------------------------

  private renderDangerZone(containerEl: HTMLElement) {
    const details = containerEl.createEl("details", { cls: "dvs-section-details dvs-danger" });
    details.createEl("summary", { text: "Danger zone" });
    details.createEl("p", { cls: "dvs-muted", text: "Use these only to recover from a broken sync. A snapshot and a backup are created first." });
    new Setting(details)
      .setName("Replace the cloud copy with this vault")
      .setDesc("Uploads this vault as the only truth. Other devices replace their files with it on their next sync.")
      .addButton((button) => button.setButtonText("Replace cloud").setWarning().onClick(async () => {
        try {
          await this.plugin.confirmAndResetCloudFromLocal();
          this.display();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "Could not replace the cloud copy.");
        }
      }));
    new Setting(details)
      .setName("Replace this vault with the cloud copy")
      .setDesc("Downloads everything from Google Drive and overwrites this device. You choose which local-only files to keep.")
      .addButton((button) => button.setButtonText("Replace this vault").setWarning().onClick(async () => {
        try {
          await this.plugin.confirmAndResetLocalFromCloud();
          this.display();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "Could not replace this vault.");
        }
      }));
    new Setting(details)
      .setName("Forget the sync state of this device")
      .setDesc("Keeps all files. The next sync compares every file from scratch.")
      .addButton((button) => button.setButtonText("Reset").onClick(() => void this.plugin.resetLocalSyncIndex()));
  }
}

function describeTime(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(timestamp).toLocaleString();
}

