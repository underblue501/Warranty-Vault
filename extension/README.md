# Warranty Vault — browser extension

Packages `index.html` as a WebExtension so the vault runs as a browser
extension instead of a web page, with its data in extension storage.

```bash
npm run build:extension
```

That writes `extension/dist/` (install this directly) and
`extension/warranty-vault-<version>.zip` (submit this to a store).

## Orion

**Orion has no developer store of its own.** It installs extensions from the
Chrome Web Store and Firefox Add-ons, and from disk. There is nothing to
"upload to Orion" — you either hand it the built folder, or list on one of
those two stores and install from there.

To install the local build:

1. Orion → Settings → **Advanced** → enable third-party extension installation.
2. Orion → **Manage Extensions** → **Add Extension** → **Install from Disk…**
3. Select `extension/dist` (the folder containing `manifest.json`). Some Orion
   versions take the `.zip` here instead — if the folder is rejected, pick the
   zip.

Orion's WebExtension support is still beta, so check the extension after an
Orion update.

## Listing on a store

| Store | What to upload | Notes |
|---|---|---|
| Chrome Web Store | `warranty-vault-<version>.zip` | one-off developer registration fee; MV3 required, which this is |
| Firefox Add-ons (AMO) | the same zip | free; AMO signs the build. `browser_specific_settings.gecko.id` in `manifest.json` is the add-on id and must stay stable across versions |

Once listed, Orion users can install from either store.

Bump `version` in `extension/manifest.json` before each submission — both
stores reject a version that has already been uploaded.

## What the build does, and why

The app ships as a single HTML file with an inline `<style>` and `<script>`.
Extension CSP (`script-src 'self'`) blocks inline script outright, so the
build lifts both into `app.css` and `app.js` and rewrites the two tags to
reference them. Nothing else about the app changes, and `index.html` stays a
single standalone file for GitHub Pages — the split exists only in `dist/`.

The build fails rather than shipping something broken if `index.html` grows a
second inline block, since the extra one would be silently blocked at runtime.

**Storage.** Inside an extension the app uses `chrome.storage.local` in
preference to `localStorage`, because extension-page `localStorage` is cleared
along with site data while extension storage is not. The tier is picked at
runtime in `load()`/`save()`, so the same file works as a page and as an
extension.

**Permissions.** `storage` only. The extension requests host access *solely*
when a receipt-scanning backend is configured: the build reads the
`scan-endpoint` meta tag from `index.html` and adds that one origin to
`host_permissions`. With no backend configured it requests no host access at
all, which is both a cleaner install prompt and an easier store review.

**No background service worker.** MV3 backgrounds differ between Chrome
(`service_worker`) and Firefox (`scripts`), and Orion runs builds of both.
The toolbar button opens a small popup that immediately opens the vault in a
full tab and closes itself — identical behaviour in all three, and
`tabs.create` needs no extra permission. A full tab rather than the popup
because the vault is a long list plus a form.

## Icons

`icons/*.png` are generated from one SVG and committed, so packaging needs no
browser. Regenerate them after changing the mark:

```bash
node extension/tools/make-icons.mjs
```

## Tests

```bash
npm run test:extension
```

Six tests. Five check the package: every file the manifest references is
emitted, no inline `<style>`, `<script>` or `on*=` handler survives, the
extracted JS and CSS match the source byte for byte, host access appears only
when a backend is configured (and a malformed endpoint fails the build), and
the zip is a well-formed archive whose entries inflate to matching bytes and
checksums.

The sixth **loads the built extension into Chromium**, opens the vault at its
`chrome-extension://` URL, files an item, and reads it back out of
`chrome.storage.local` after a reload. That is what proves CSP actually
permits the extracted script — a packaging check alone would pass on a build
the browser refuses to run.
