import test from 'node:test';
import assert from 'node:assert/strict';
import { handleScan, __resetRateLimit } from '../src/index.ts';

const ORIGIN = 'https://underblue501.github.io';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const env = (over = {}) => ({
  ANTHROPIC_API_KEY: 'sk-ant-test',
  ALLOWED_ORIGINS: ORIGIN,
  RATE_LIMIT_PER_MINUTE: '100',
  ...over
});

const post = (body, { origin = ORIGIN, headers = {} } = {}) =>
  new Request('https://scan.example.workers.dev/scan', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(origin ? { Origin: origin } : {}),
      'CF-Connecting-IP': '203.0.113.7',
      ...headers
    },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });

const receipt = {
  is_receipt: true, name: 'Bosch dishwasher', price: 899,
  date: '2026-01-31', store: 'Lowes', months: 24, category: 'Appliances'
};

const okScanner = async () => receipt;
const failing = err => async () => { throw err; };

test.beforeEach(() => __resetRateLimit());

test('a valid scan returns the shape the browser already parses', async () => {
  let seen = null;
  const res = await handleScan(post({ image: PNG, media_type: 'image/png' }), env(),
    async opts => { seen = opts; return receipt; });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.deepEqual(await res.json(), {
    name: 'Bosch dishwasher', price: 899, date: '2026-01-31',
    store: 'Lowes', months: 24, category: 'Appliances'
  });
  assert.equal(seen.mediaType, 'image/png');
  assert.equal(seen.imageBase64, PNG);
  assert.equal(seen.model, 'claude-opus-5', 'the documented default model');
});

test('the API key never reaches the client', async () => {
  const res = await handleScan(post({ image: PNG, media_type: 'image/png' }), env(), okScanner);
  const body = await res.text();
  assert.ok(!body.includes('sk-ant-test'), 'the key is not in the body');
  for (const [, value] of res.headers) {
    assert.ok(!String(value).includes('sk-ant-test'), 'the key is not in a header');
  }
});

test('a non-receipt image is reported as such', async () => {
  const res = await handleScan(post({ image: PNG, media_type: 'image/png' }), env(),
    async () => ({ ...receipt, is_receipt: false }));
  assert.deepEqual(await res.json(), { error: 'not a receipt' });
});

test('preflight is answered for an allowed origin only', async () => {
  const ok = await handleScan(new Request('https://x/scan', {
    method: 'OPTIONS', headers: { Origin: ORIGIN } }), env(), okScanner);
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), ORIGIN);

  const bad = await handleScan(new Request('https://x/scan', {
    method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), env(), okScanner);
  assert.equal(bad.headers.get('Access-Control-Allow-Origin'), null,
    'no CORS grant for an unlisted origin');
});

test('an unlisted origin is refused server-side, not just by CORS', async () => {
  let called = false;
  const res = await handleScan(
    post({ image: PNG, media_type: 'image/png' }, { origin: 'https://evil.example' }),
    env(), async () => { called = true; return receipt; });
  assert.equal(res.status, 403);
  assert.equal(called, false, 'no API call was made for a rejected origin');
});

test('the wrong path and method are refused', async () => {
  const wrongPath = await handleScan(new Request('https://x/admin', {
    method: 'POST', headers: { Origin: ORIGIN } }), env(), okScanner);
  assert.equal(wrongPath.status, 404);

  const wrongMethod = await handleScan(new Request('https://x/scan', {
    method: 'GET', headers: { Origin: ORIGIN } }), env(), okScanner);
  assert.equal(wrongMethod.status, 405);
});

test('malformed and hostile payloads never reach the API', async () => {
  const cases = [
    ['not json at all', 400, 'invalid JSON'],
    [{}, 400, 'no image'],
    [{ image: '', media_type: 'image/png' }, 400, 'empty image'],
    [{ image: 'not!base64!', media_type: 'image/png' }, 400, 'not base64'],
    [{ image: PNG }, 415, 'no media type'],
    [{ image: PNG, media_type: 'application/pdf' }, 415, 'disallowed media type'],
    [{ image: PNG, media_type: 'text/html' }, 415, 'html media type'],
    [{ image: 123, media_type: 'image/png' }, 400, 'non-string image']
  ];
  for (const [body, status, label] of cases) {
    let called = false;
    const res = await handleScan(post(body), env(), async () => { called = true; return receipt; });
    assert.equal(res.status, status, `${label} -> expected ${status}, got ${res.status}`);
    assert.equal(called, false, `${label}: no API call`);
  }
});

test('an oversized image is rejected before the API call', async () => {
  const huge = 'A'.repeat(9_000_000);   // ~6.75 MB decoded
  let called = false;
  const res = await handleScan(post({ image: huge, media_type: 'image/png' }),
    env({ MAX_IMAGE_BYTES: '5242880' }),
    async () => { called = true; return receipt; });
  assert.equal(res.status, 413);
  assert.equal(called, false, 'the oversized image was never forwarded');
});

test('the rate limit stops a burst and reports Retry-After', async () => {
  const e = env({ RATE_LIMIT_PER_MINUTE: '3' });
  const statuses = [];
  for (let i = 0; i < 5; i++) {
    const res = await handleScan(post({ image: PNG, media_type: 'image/png' }), e, okScanner);
    statuses.push(res.status);
    if (res.status === 429) assert.equal(res.headers.get('Retry-After'), '60');
  }
  assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
});

test('the rate limit is per client address', async () => {
  const e = env({ RATE_LIMIT_PER_MINUTE: '1' });
  const first = await handleScan(post({ image: PNG, media_type: 'image/png' }), e, okScanner);
  assert.equal(first.status, 200);
  const same = await handleScan(post({ image: PNG, media_type: 'image/png' }), e, okScanner);
  assert.equal(same.status, 429);
  const other = await handleScan(
    post({ image: PNG, media_type: 'image/png' }, { headers: { 'CF-Connecting-IP': '198.51.100.9' } }),
    e, okScanner);
  assert.equal(other.status, 200, 'a different address is not punished');
});

test('a missing API key fails closed without calling out', async () => {
  let called = false;
  const res = await handleScan(post({ image: PNG, media_type: 'image/png' }),
    env({ ANTHROPIC_API_KEY: '' }), async () => { called = true; return receipt; });
  assert.equal(res.status, 500);
  assert.equal(called, false);
  assert.match((await res.json()).error.message, /not configured/);
});

test('upstream failures are surfaced without leaking internals', async () => {
  class ScanErrorLike extends Error {
    constructor(m, s) { super(m); this.name = 'ScanError'; this.status = s; }
  }
  const res = await handleScan(post({ image: PNG, media_type: 'image/png' }), env(),
    failing(new Error('connect ECONNREFUSED 10.0.0.1:443 apiKey=sk-ant-secret')));
  assert.equal(res.status, 500);
  const body = await res.text();
  assert.ok(!body.includes('sk-ant-secret'), 'no secret in the error body');
  assert.ok(!body.includes('10.0.0.1'), 'no internal address in the error body');
  assert.match(JSON.parse(body).error.message, /unexpectedly/);
});

test('with no allowlist configured the origin check is open', async () => {
  // Documented behaviour for local development.
  const res = await handleScan(
    post({ image: PNG, media_type: 'image/png' }, { origin: 'http://localhost:8080' }),
    env({ ALLOWED_ORIGINS: '' }), okScanner);
  assert.equal(res.status, 200);
});
