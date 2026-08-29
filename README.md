# Warranty Vault

**Stop paying for repairs you already paid for.**

Every year, people spend money on repairs and replacements for products that were still under warranty — they just forgot. Warranty Vault tracks every warranty you own, warns you before coverage expires, and writes your claim letter when something breaks.

## Features

- **AI receipt scanning** — snap a photo of a receipt and the item, price, retailer, purchase date, and estimated warranty length are filled in automatically
- **Live countdown stamps** — every purchase is filed as a receipt stub: green while covered, amber inside the final 30 days, red when expired
- **Expiry watch** — a banner surfaces anything expiring within 30 days, and each item can generate a calendar reminder (.ics) set for two weeks before coverage ends
- **One-tap claim letters** — a professionally worded warranty claim, pre-filled with your purchase details, ready to copy and send
- **Coverage extension offers** — items entering their final 30 days surface an extend-coverage option (simulated in this demo; this is the affiliate revenue hook in production)

## Running it

The app is a single dependency-free HTML file.

Open `index.html` in a browser, or serve it with GitHub Pages: in the repo settings, enable Pages from the main branch and it will be live at `https://<your-username>.github.io/<repo-name>/`.

## Known limitations outside Claude

This prototype was built to run inside a Claude artifact, where two capabilities are provided by the environment:

1. **Receipt scanning** calls the Anthropic API without an API key, which only works inside Claude. On GitHub Pages the scan button will show an error and manual entry still works. To enable it on the open web, route the request through a small backend that holds your own Anthropic API key (never put the key in client-side code).
2. **Persistence** uses the artifact storage API. Outside Claude, data is held in memory only and resets on refresh. Swap in `localStorage`, IndexedDB, or a backend for real persistence.

Everything else — logging, countdowns, alerts, claim letters, reminders, extensions — works anywhere.

## Roadmap

- Push/email notifications ahead of expiry
- Real extended-warranty partner integrations
- Multi-photo product records (receipt + serial number + damage photos for claims)
- Household sharing

## Tech

Single-file HTML/CSS/JS. No frameworks, no build step, no dependencies.
