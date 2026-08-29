# Warranty Vault — receipt scanning backend

A Cloudflare Worker that holds your Anthropic API key and forwards receipt
images to the Messages API. The browser never sees the key.

Without this, the page calls `api.anthropic.com` directly, which only works
inside a Claude artifact where the environment supplies credentials. On
GitHub Pages that call fails, and putting a key in client-side code would
publish it.

## Deploy

```bash
cd backend
npm install
npx wrangler login
```

Set the origins allowed to call it in `wrangler.toml` — your Pages URL:

```toml
[vars]
ALLOWED_ORIGINS = "https://<your-username>.github.io"
```

Store the key as a **secret**, never as a var (vars are readable in the
dashboard and committed to this file):

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler deploy
```

Then point the page at the deployed Worker — edit the meta tag near the top
of `../index.html`:

```html
<meta name="scan-endpoint" content="https://warranty-vault-scan.<you>.workers.dev/scan">
```

Commit that and the scan button works on the open web.

## Configuration

| Setting | Where | Default | Notes |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | secret | — | required; `wrangler secret put` |
| `ALLOWED_ORIGINS` | var | — | comma-separated. **Empty disables the origin check** — local dev only |
| `SCAN_MODEL` | var | `claude-opus-5` | any current model id |
| `SCAN_EFFORT` | var | `low` | `low`–`max`; raise for accuracy, at more latency and cost |
| `MAX_IMAGE_BYTES` | var | `5242880` | 5 MB, checked before the API call |
| `RATE_LIMIT_PER_MINUTE` | var | `12` | per client IP |
| `RATE_LIMIT` | KV binding | unbound | see below |

`SCAN_EFFORT` defaults to `low` because this is a short extraction that a
human reviews before filing — the form is pre-filled, not auto-submitted.
Raise it if receipts are coming back wrong.

## Abuse protection — read this before deploying

This endpoint spends your money. Anyone who finds the URL can call it.

What is built in:

- **Origin allowlist**, enforced server-side as well as via CORS. Note that
  an `Origin` header is trivially spoofed by a non-browser client, so treat
  this as friction, not a control.
- **Per-IP rate limit**, 12/minute by default, keyed on `CF-Connecting-IP`.
- **Size, format, and encoding checks** before anything is forwarded.
- **Fail-closed** on a missing key.

The rate limiter uses KV when bound and falls back to a per-isolate counter
when not. Cloudflare runs many isolates, so **the fallback is weak** — bind
KV for a limit that actually holds:

```bash
npx wrangler kv namespace create RATE_LIMIT
```

then uncomment the `[[kv_namespaces]]` block in `wrangler.toml` and paste the
id. KV is eventually consistent, so the limit is a coarse ceiling rather than
an exact count.

For anything beyond a personal deployment, add a **rate limiting rule in the
Cloudflare dashboard** (Security → WAF → Rate limiting rules) in front of the
Worker, and consider **Turnstile** so only real browsers can call it. Both are
configured in the dashboard rather than in this repo.

## Local development

```bash
npm run dev        # wrangler dev on localhost:8787
npm run typecheck
npm test           # 13 tests, no network and no API spend
```

The tests inject a fake scanner, so they exercise CORS, the origin check, the
rate limiter, payload validation, and error mapping without calling Anthropic
or costing anything.

To test the page against a local Worker, set the endpoint in the browser
console before scanning:

```js
window.WARRANTY_VAULT_SCAN_ENDPOINT = 'http://localhost:8787/scan';
```

and leave `ALLOWED_ORIGINS` empty while doing so.

## How it extracts fields

`src/scan.ts` uses **structured outputs** — a Zod schema passed through
`zodOutputFormat`, with `client.messages.parse()`. The API enforces the shape,
so the response cannot come back as prose or a markdown fence, and there is no
hand-rolled JSON parsing to go wrong. `parsed_output` is `null` if the model
could not satisfy the schema, which is reported as a clean 422.

The Worker answers in the shape the page already understands: the extracted
fields, or `{"error": "not a receipt"}`.
