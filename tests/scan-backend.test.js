import test from 'node:test';
import assert from 'node:assert/strict';
import { withPage, APP_URL } from './helpers.js';

const ENDPOINT = 'https://scan.example.workers.dev/scan';
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
  '0000000a49444154789c6360000002000100fdff03fa0000000049454e44ae426082', 'hex');

/* Configures the page to use a backend, then intercepts it. Also watches
   api.anthropic.com so a leak to the direct path is caught. */
async function scanVia(handler, { endpoint = ENDPOINT } = {}){
  return withPage({
    timezoneId: 'UTC',
    goto: false,
    init: `window.WARRANTY_VAULT_SCAN_ENDPOINT = ${JSON.stringify(endpoint)}`
  }, async page => {
    let request = null, direct = 0;
    await page.route('https://api.anthropic.com/**', route => { direct++; return route.abort(); });
    await page.route(ENDPOINT, route => {
      request = { headers: route.request().headers(), body: JSON.parse(route.request().postData()) };
      return handler(route);
    });
    await page.goto(APP_URL);
    await page.setInputFiles('#scanInput', { name: 'r.png', mimeType: 'image/png', buffer: PNG });
    await page.waitForFunction(
      () => !document.getElementById('scanStatus').textContent.includes('Reading'),
      null, { timeout: 10000 });
    return {
      request, direct,
      status: (await page.textContent('#scanStatus')).trim(),
      fields: await page.evaluate(() => ({
        name: fName.value, price: fPrice.value, date: fDate.value,
        store: fStore.value, cat: fCat.value, months: fMonths.value
      })),
      errors: page.uncaughtErrors
    };
  });
}

const jsonRoute = (status, body) => route =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

test('a configured backend is used instead of the Anthropic API', async () => {
  const r = await scanVia(jsonRoute(200, {
    name: 'Bosch dishwasher', price: 899, date: '2026-02-14',
    store: 'Lowes', months: 24, category: 'Appliances'
  }));
  assert.equal(r.direct, 0, 'the browser never contacted api.anthropic.com');
  assert.ok(r.request, 'the backend was called');
  assert.equal(r.request.body.media_type, 'image/png');
  assert.ok(r.request.body.image, 'the image was sent as base64');
  assert.ok(!('model' in r.request.body), 'model choice stays on the server');
});

test('no API credentials are sent from the browser', async () => {
  const r = await scanVia(jsonRoute(200, { name: 'X' }));
  const headerNames = Object.keys(r.request.headers).map(h => h.toLowerCase());
  assert.ok(!headerNames.includes('x-api-key'), 'no x-api-key header');
  assert.ok(!headerNames.includes('authorization'), 'no authorization header');
  assert.ok(!headerNames.some(h => h.startsWith('anthropic-')), 'no anthropic-* headers');
  const raw = JSON.stringify(r.request.body);
  assert.ok(!/sk-ant/.test(raw), 'no key material in the body');
});

test('the backend response fills the form', async () => {
  const r = await scanVia(jsonRoute(200, {
    name: 'Bosch dishwasher', price: 899, date: '2026-02-14',
    store: 'Lowes', months: 24, category: 'Appliances'
  }));
  assert.match(r.status, /Fields filled/);
  assert.deepEqual(r.fields, {
    name: 'Bosch dishwasher', price: '899', date: '2026-02-14',
    store: 'Lowes', cat: 'Appliances', months: '24'
  });
  assert.deepEqual(r.errors, []);
});

test('a non-receipt answer from the backend is reported', async () => {
  const r = await scanVia(jsonRoute(200, { error: 'not a receipt' }));
  assert.match(r.status, /does not look like a receipt/);
});

test('backend errors surface their message', async () => {
  const rate = await scanVia(jsonRoute(429, {
    error: { message: 'too many scans from this address. Try again in a minute.' } }));
  assert.match(rate.status, /too many scans/);
  assert.doesNotMatch(rate.status, /undefined/);

  const down = await scanVia(jsonRoute(502, { error: { message: 'the scanning service failed.' } }));
  assert.match(down.status, /scanning service failed/);

  const html = await scanVia(route =>
    route.fulfill({ status: 500, contentType: 'text/html', body: '<html>oops</html>' }));
  assert.match(html.status, /500/);
  assert.doesNotMatch(html.status, /Unexpected/);
});

test('a backend that cannot be reached is reported, not thrown', async () => {
  const r = await scanVia(route => route.abort('failed'));
  assert.match(r.status, /Scan failed/);
  assert.match(r.status, /enter it by hand/);
  assert.deepEqual(r.errors, []);
});

test('every backend failure message still reads as one sentence', async () => {
  const r = await scanVia(jsonRoute(413, { error: { message: 'that image is too large.' } }));
  assert.match(r.status, /^Scan failed — .+\. You can still enter it by hand\.$/, r.status);
});

test('with no endpoint configured the direct path is still used', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    let direct = 0;
    await page.route('https://api.anthropic.com/**', route => {
      direct++;
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ content: [{ type: 'text', text: '{"name":"Direct"}' }] }) });
    });
    await page.setInputFiles('#scanInput', { name: 'r.png', mimeType: 'image/png', buffer: PNG });
    await page.waitForFunction(
      () => !document.getElementById('scanStatus').textContent.includes('Reading'),
      null, { timeout: 10000 });
    assert.equal(direct, 1, 'the artifact path is unchanged when no backend is set');
    assert.equal(await page.inputValue('#fName'), 'Direct');
  });
});

test('the endpoint can be set by the meta tag', async () => {
  await withPage({
    timezoneId: 'UTC', goto: false,
    init: () => {
      document.addEventListener('DOMContentLoaded', () => {}, { once: true });
    }
  }, async page => {
    await page.goto(APP_URL);
    const meta = await page.getAttribute('meta[name="scan-endpoint"]', 'content');
    assert.equal(meta, '', 'ships empty so the artifact path is the default');
    assert.equal(await page.evaluate(() => typeof scanEndpoint), 'function');
    assert.equal(await page.evaluate(() => scanEndpoint()), '');
  });
});
