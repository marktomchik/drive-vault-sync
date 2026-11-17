// Patch set for drive-vault-sync 1.2.0 (release main.js) -> 1.2.1.
// Each entry: [label, find, replace]. Every `find` must match exactly once.
// Goal: a phone can be signed in even when its camera app does not open obsidian:// links.
export default [
["transfer-decode",
`function js(r) {
  let t = r.replace(/-/g, "+").replace(/_/g, "/"), e = atob(t);
  return JSON.parse(e);
}`,
`function js(r) {
  // 1.2.1: accepts the whole obsidian:// link, any text that contains "payload=", or the bare code.
  let t = String(r == null ? "" : r).trim();
  try {
    t = decodeURIComponent(t);
  } catch (x) {
  }
  let m = t.match(/payload=([^&#]+)/);
  m && (t = m[1]);
  t = t.replace(/\\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  for (; t.length % 4; ) t += "=";
  let e = JSON.parse(atob(t));
  if (!e || e.v !== 1 || typeof e.encrypted != "boolean") throw new Error("Not a sign-in code.");
  return e;
}`],

["qr-link-variable",
`let e = this.usePassword ? await Ws(this.auth, this.password) : { v: 1, encrypted: false, auth: this.auth }, n = await Qs(zs(e));`,
`let e = this.usePassword ? await Ws(this.auth, this.password) : { v: 1, encrypted: false, auth: this.auth }, dvsLink = zs(e), n = await Qs(dvsLink);`],

["qr-copy-button",
`cls: "dvs-muted" });
    } catch (e) {
      this.errorEl.setText(e instanceof Error ? e.message : "Could not generate the QR code.");`,
`cls: "dvs-muted" });
      this.qrEl.createEl("p", { text: "Does the camera only search the text instead of opening Obsidian? Copy the link, send it to the other device (for example to yourself in a messenger), and paste it there under \\u201CSign in with a link from another device\\u201D.", cls: "dvs-muted" });
      let dvsCopy = this.qrEl.createEl("button", { text: "Copy sign-in link", cls: "mod-cta" });
      dvsCopy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(dvsLink), new S.Notice("Sign-in link copied. It contains your Google access \\u2014 delete the message after use.");
        } catch (x) {
          new S.Notice("Could not copy the link.");
        }
      });
    } catch (e) {
      this.errorEl.setText(e instanceof Error ? e.message : "Could not generate the QR code.");`],

["connect-accepts-desktop-client",
`if (!this.plugin.settings.clientId || !this.plugin.settings.clientSecret) {`,
`if (!this.plugin.canConnectWithFullAccess() && (!this.plugin.settings.clientId || !this.plugin.settings.clientSecret)) {`],

["setup-desktop-client-fields",
`}), new b.Setting(e).setName("Step 3 \\u2014 Sign in with Google")`,
`}), Ue() && (() => {
      let g = e.createEl("details", { cls: "dvs-guide" });
      g.open = !!this.plugin.settings.desktopClientId;
      g.createEl("summary", { text: "On a computer: full access with a \\u201CDesktop app\\u201D client (recommended)" });
      g.createEl("p", { cls: "dvs-muted", text: "Lets the plugin import notes that other apps add to the vault folder in Google Drive. When both fields are filled in, Connect signs in through the browser and Step 2 can stay empty." });
      new b.Setting(g).setName("Desktop client ID").addText((i) => i.setPlaceholder("1234567890-abc\\u2026.apps.googleusercontent.com").setValue(this.plugin.settings.desktopClientId).onChange(async (o) => {
        this.plugin.settings.desktopClientId = o.trim(), await this.plugin.saveSettings();
      }));
      new b.Setting(g).setName("Desktop client secret").addText((i) => {
        i.inputEl.type = "password", i.setPlaceholder("Client secret").setValue(this.plugin.settings.desktopClientSecret).onChange(async (o) => {
          this.plugin.settings.desktopClientSecret = o.trim(), await this.plugin.saveSettings();
        });
      });
    })(), new b.Setting(e).setName("Step 3 \\u2014 Sign in with Google")`],

["setup-paste-link",
`e.createEl("p", { cls: "dvs-muted", text: "Already set up on another device? Open these settings there, choose \\u201CSign in on another device\\u201D and scan the QR code with this device's camera." });`,
`e.createEl("p", { cls: "dvs-muted", text: "Already set up on another device? Open these settings there, choose \\u201CSign in on another device\\u201D and scan the QR code with this device's camera \\u2014 or copy the link there and paste it below." });
    let dvsCode = "";
    new b.Setting(e).setName("Sign in with a link from another device").setDesc("Paste the link (or the text your camera read from the QR code) from \\u201CSign in on another device\\u201D.").addTextArea((i) => {
      i.setPlaceholder("obsidian://drive-vault-sync?payload=\\u2026").onChange((o) => {
        dvsCode = o;
      }), i.inputEl.rows = 3;
    }).addButton((i) => i.setButtonText("Sign in").setCta().onClick(async () => {
      if (!dvsCode.trim()) {
        new b.Notice("Paste the sign-in link first.");
        return;
      }
      await this.plugin.handleAuthImport(dvsCode), this.display();
    }));`]
];
