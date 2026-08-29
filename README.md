# Warranty Vault

**Stop paying for repairs you already paid for.**

Every year, people spend money on repairs and replacements for products that were still under warranty — they just forgot. Warranty Vault tracks every warranty you own, warns you before coverage expires, and writes your claim letter when something breaks.

## Features

- **AI receipt scanning** — snap a photo of a receipt and the item, price, retailer, purchase date, and estimated warranty length are filled in automatically
- **Live countdown stamps** — every purchase is filed as a receipt stub: green while covered, amber inside the final 30 days, red when expired
- **Expiry watch** — a banner surfaces anything expiring within 30 days, and each item can generate a calendar reminder (.ics) set for two weeks before coverage ends
- **One-tap claim letters** — a professionally worded warranty claim, pre-filled with your purchase details, ready to copy and send
- **Coverage extension offers** — items entering their final 30 days surface an extend-coverage option (simulated in this demo; this is the affiliate revenue hook in production)
- **Export and import** — download the whole vault as JSON and restore it in another browser, so a browser change or a cleared cache is not the end of your records

## Running it

The app is a single dependency-free HTML file.

Open `index.html` in a browser, or serve it with GitHub Pages: in the repo settings, enable Pages from the main branch and it will be live at `https://<your-username>.github.io/<repo-name>/`.

## Known limitations outside Claude

This prototype was built to run inside a Claude artifact. One capability is still provided by that environment:

**Receipt scanning** calls the Anthropic API without an API key, which only works inside Claude. Anywhere else the scan button reports why it failed and manual entry still works. To enable it on the open web, route the request through a small backend that holds your own Anthropic API key (never put the key in client-side code).

Everything else — logging, countdowns, alerts, claim letters, reminders, extensions — works anywhere.

## Where your data lives

Your vault is stored on your own device. The app uses the artifact storage API when running inside Claude, and falls back to `localStorage` in any ordinary browser, so data survives a refresh on GitHub Pages or from a local file. Your item records are never uploaded — the only thing that leaves the browser is a receipt photo you choose to scan, sent to the Anthropic API for that one request.

Two consequences worth knowing:

- It is **per browser, per device**. There is no sync, so clearing site data clears the vault — use **export vault** below the list to keep a JSON copy, and **import backup** to restore it somewhere else. Import merges by item id: it adds what is missing and never removes or overwrites what is already there, so re-importing the same file is harmless.
- Storage can be unavailable — private-browsing modes and a full quota both make writes fail. When that happens the app says so in a banner rather than pretending the item was filed. If it finds stored data it cannot read, it stops saving instead of overwriting it, so a recoverable copy is left alone under the `vault-items` key.

For sync across devices or a real backup, this is the seam to replace: `load()` and `save()` near the top of the script are the only functions that touch storage.

## Roadmap

- Push/email notifications ahead of expiry
- Real extended-warranty partner integrations
- Multi-photo product records (receipt + serial number + damage photos for claims)
- Household sharing

## Tests

The app itself stays dependency-free; the test suite is dev-only tooling.

```
npm install
npx playwright install chromium
npm test
```

75 tests drive `index.html` in a real browser (Playwright + the built-in
`node --test` runner), so they exercise the browser's own `Date` and `Intl`
behaviour rather than a stand-in. Coverage: date handling across six
timezones from UTC-8 to UTC+14, month-end and DST edges, `.ics` validity
against RFC 5545, storage-failure and corrupt-data paths, the receipt-scan
request shape and each of its error paths, and the claim-letter, download,
clipboard, search and escaping behaviour of the UI, plus form submission,
price validation, duplicate detection, the extend-coverage record, and the
import path including malformed files and hostile field values.

Colour contrast is measured from the browser's own computed styles rather
than from hex literals, so retuning the palette re-checks it against the
WCAG AA 4.5:1 threshold automatically.

CI runs the same suite on every pull request (`.github/workflows/ci.yml`).

## Tech

Single-file HTML/CSS/JS. No frameworks, no build step, no runtime
dependencies.
