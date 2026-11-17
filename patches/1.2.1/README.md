# drive-vault-sync 1.2.1 — patch on top of the 1.2.0 release bundle

Like 1.2.0, this is a find/replace patch on the released `main.js` (the 1.1.0+ TypeScript source is still missing from `src/`).

- Apply: `node apply.mjs <1.2.0 main.js> out.js`
- Test: `BUNDLE=out.js node --test patch.test.mjs` (and the 1.2.0 tests still pass on `out.js`)

## What changed

1. **Sign in on a phone without the camera opening Obsidian.** Some camera apps (e.g. Xiaomi) treat the `obsidian://` QR link as text and search the web for it.
   - "Sign in on another device" now has a **Copy sign-in link** button under the QR code.
   - The connect screen (phone and computer) has **Sign in with a link from another device**: paste the link, or the text the camera read, and press Sign in.
   - Decoding accepts the full link, any text that contains `payload=`, a percent-encoded link, or the bare code; whitespace and line breaks are ignored. Anything that is not a sign-in code is rejected.
2. **Desktop app client on the connect screen.** Before, the Desktop client fields only appeared after connecting, so a fresh install could only use the device-code sign-in (limited `drive.file` access). On a computer the connect screen now shows the Desktop client ID/secret, and **Connect** signs in through the browser with full access when they are filled in (Step 2 may stay empty).
3. **Version:** `manifest.json` 1.2.1.
