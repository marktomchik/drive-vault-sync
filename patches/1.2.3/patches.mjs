// Patch set for drive-vault-sync 1.2.2 (release main.js) -> 1.2.3.
// Each entry: [label, find, replace]. Every `find` must match exactly once.
// Goal: remove plugin delivery (DvsPluginStaging, added in 1.2.0). Plugin updates now come from GitHub via BRAT.
// Strings are JSON-encoded because the removed code contains template literals.
export default [
// Delete DvsPluginStaging, DVS_STAGED_FILES and dvsCompareVersions.
["remove-plugin-staging-class",
"var DVS_STAGED_FILES = [\"main.js\", \"manifest.json\", \"styles.css\"];\nfunction dvsCompareVersions(a, b) {\n  let x = String(a || \"0\").split(/[.-]/).map((v) => parseInt(v, 10) || 0), y = String(b || \"0\").split(/[.-]/).map((v) => parseInt(v, 10) || 0);\n  for (let i = 0; i < Math.max(x.length, y.length); i++) {\n    let d = (x[i] || 0) - (y[i] || 0);\n    if (d) return d > 0 ? 1 : -1;\n  }\n  return 0;\n}\nvar DvsPluginStaging = class {\n  constructor(app, getFolder, getIds, log) {\n    this.app = app;\n    this.getFolder = getFolder;\n    this.getIds = getIds;\n    this.log = log;\n  }\n  installedDir(id) {\n    return (0, dvsObs.normalizePath)(`${this.app.vault.configDir}/plugins/${id}`);\n  }\n  stagedDir(id) {\n    return (0, dvsObs.normalizePath)(`${this.getFolder()}/${id}`);\n  }\n  async readManifest(path) {\n    let a = this.app.vault.adapter;\n    try {\n      return await a.exists(path) ? JSON.parse(await a.read(path)) : null;\n    } catch (e) {\n      return null;\n    }\n  }\n  validId(id) {\n    return /^[a-z0-9][a-z0-9._-]*$/i.test(id) && !id.includes(\"..\");\n  }\n  /** Desktop: copy installed plugins into the staging folder when the installed version is newer. Never downgrades. */\n  async publish(force = false) {\n    let done = [], vault = this.app.vault;\n    for (let id of this.getIds()) {\n      if (!this.validId(id)) continue;\n      let inst = await this.readManifest(`${this.installedDir(id)}/manifest.json`), staged = await this.readManifest(`${this.stagedDir(id)}/manifest.json`);\n      if (!inst || inst.id !== id) continue;\n      let cmp = staged ? dvsCompareVersions(inst.version, staged.version) : 1;\n      if (cmp < 0 || cmp === 0 && !force) continue;\n      let dir = this.stagedDir(id);\n      for (let part of [this.getFolder(), dir]) vault.getAbstractFileByPath(part) || await vault.createFolder(part).catch(() => void 0);\n      for (let f of DVS_STAGED_FILES) {\n        let src = `${this.installedDir(id)}/${f}`;\n        if (f === \"manifest.json\" || !await vault.adapter.exists(src)) continue;\n        await this.writeVault(`${dir}/${f}`, await vault.adapter.read(src));\n      }\n      await this.writeVault(`${dir}/manifest.json`, await vault.adapter.read(`${this.installedDir(id)}/manifest.json`));\n      done.push(`${id} ${inst.version}`);\n    }\n    return done.length && await this.log(\"plugin-staging-published\", { plugins: done }), done;\n  }\n  async writeVault(path, text) {\n    let vault = this.app.vault, f = vault.getAbstractFileByPath(path);\n    if (f instanceof dvsObs.TFile) {\n      (await vault.read(f)) !== text && await vault.modify(f, text);\n    } else await vault.create(path, text);\n  }\n  /** Copy plugins from the staging folder into the config folder when the staged version is newer. Never touches data.json. */\n  async installNewer() {\n    let done = [], a = this.app.vault.adapter;\n    for (let id of this.getIds()) {\n      if (!this.validId(id)) continue;\n      let sdir = this.stagedDir(id), staged = await this.readManifest(`${sdir}/manifest.json`);\n      if (!staged || staged.id !== id || !await a.exists(`${sdir}/main.js`)) continue;\n      let idir = this.installedDir(id), inst = await this.readManifest(`${idir}/manifest.json`);\n      if (inst && dvsCompareVersions(staged.version, inst.version) <= 0) continue;\n      await a.exists(idir) || await a.mkdir(idir);\n      await a.exists(`${idir}/main.js`) && await a.write(`${idir}/main.js.prev`, await a.read(`${idir}/main.js`));\n      for (let f of DVS_STAGED_FILES) f !== \"manifest.json\" && await a.exists(`${sdir}/${f}`) && await a.write(`${idir}/${f}`, await a.read(`${sdir}/${f}`));\n      await a.write(`${idir}/manifest.json`, await a.read(`${sdir}/manifest.json`));\n      done.push(`${id} ${staged.version}`);\n    }\n    return done.length && await this.log(\"plugin-staging-installed\", { plugins: done }), done;\n  }\n};\n",
""],

// Drop the staging settings from the defaults.
["remove-staging-defaults",
", pluginStagingFolder: \"Плагіни\", stagedPluginIds: \"drive-vault-sync\", autoInstallStagedPlugins: true };",
" };"],

// Remove the "Plugins for other devices" section from the settings tab.
["remove-staging-settings-ui",
"    new b.Setting(e).setName(\"Plugins for other devices\").setHeading();\n    new b.Setting(e).setName(\"Folder\").setDesc(\"A normal vault folder that carries plugin code to your other devices (the settings folder itself is never synced). data.json is never copied.\").addText((s) => s.setValue(n.pluginStagingFolder).onChange(async (i) => {\n      n.pluginStagingFolder = i.trim() || K.pluginStagingFolder, await this.plugin.saveSettings();\n    }));\n    new b.Setting(e).setName(\"Plugin IDs\").setDesc(\"One per line.\").addTextArea((s) => s.setValue(n.stagedPluginIds).onChange(async (i) => {\n      n.stagedPluginIds = i, await this.plugin.saveSettings();\n    }));\n    new b.Setting(e).setName(\"Install newer versions automatically\").setDesc(\"After a sync, newer plugin versions from the folder are installed (the previous main.js is kept as main.js.prev). Restart Obsidian afterwards.\").addToggle((s) => s.setValue(n.autoInstallStagedPlugins).onChange(async (i) => {\n      n.autoInstallStagedPlugins = i, await this.plugin.saveSettings();\n    })).addButton((s) => s.setButtonText(\"Copy now\").onClick(() => void this.plugin.publishStagedPlugins(true)));\n",
""],

// Stop creating the staging helper on load.
["remove-staging-instance",
"this.pluginStaging = new DvsPluginStaging(this.app, () => this.settings.pluginStagingFolder.trim() || K.pluginStagingFolder, () => this.settings.stagedPluginIds.split(/\\r?\\n|,/).map((e) => e.trim()).filter(Boolean), (e, n) => this.appendSyncLog(e, n)), ",
""],

// Remove publishStagedPlugins / installStagedPlugins.
["remove-staging-methods",
"  async publishStagedPlugins(e = false) {\n    if (!Ue() || !this.pluginStaging) return;\n    try {\n      let n = await this.pluginStaging.publish(e);\n      e && new D.Notice(n.length ? `Copied for other devices: ${n.join(\", \")}` : \"The plugin folder for other devices is already up to date.\");\n    } catch (n) {\n      await this.appendSyncLog(\"plugin-staging-publish-failed\", this.errorDetails(n));\n    }\n  }\n  async installStagedPlugins(e = false) {\n    if (!this.pluginStaging || !e && !this.settings.autoInstallStagedPlugins) return;\n    try {\n      let n = await this.pluginStaging.installNewer();\n      n.length ? new D.Notice(`Plugins updated: ${n.join(\", \")}. Restart Obsidian to use the new versions.`, 0) : e && new D.Notice(\"No newer plugins in the staging folder.\");\n    } catch (n) {\n      await this.appendSyncLog(\"plugin-staging-install-failed\", this.errorDetails(n));\n    }\n  }\n",
""],

// No plugin copy before a sync.
["remove-staging-before-sync",
"      await this.publishStagedPlugins(false);\n",
""],

// No plugin install after a sync.
["remove-staging-after-sync",
", await this.appendSyncLog(\"sync-finished\", o), o && await this.installStagedPlugins();",
", await this.appendSyncLog(\"sync-finished\", o);"],

// Remove the two plugin-delivery commands.
["remove-staging-commands",
", this.addCommand({ id: \"publish-plugins-for-devices\", name: \"Copy plugins to the folder for other devices\", icon: \"package\", callback: () => void this.publishStagedPlugins(true) }), this.addCommand({ id: \"install-staged-plugins\", name: \"Install newer plugins from the folder for other devices\", icon: \"download\", callback: () => void this.installStagedPlugins(true) });",
";"],

// Forget the old staging settings stored in data.json (the staging folder in the vault is left untouched).
["drop-old-staging-keys",
"    this.settings = s;\n  }\n  async saveSettings() {",
"    delete s.pluginStagingFolder, delete s.stagedPluginIds, delete s.autoInstallStagedPlugins;\n    this.settings = s;\n  }\n  async saveSettings() {"]
];
