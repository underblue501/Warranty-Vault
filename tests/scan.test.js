import test from 'node:test';
import assert from 'node:assert/strict';
import { withPage, APP_URL } from './helpers.js';

// Smallest valid 1x1 PNG, so the file reader has something real to read.
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
  '0000000a49444154789c6360000002000100fdff03fa0000000049454e44ae426082', 'hex');

/* Intercepts the API call so the tests cover request shape and every failure
   path without ever reaching the network. */
async function scan(handler){
  return withPage({ timezoneId: 'America/Los_Angeles', goto: false }, async page => {
    let request = null;
    await page.route('https://api.anthropic.com/**', route => {
      request = { headers: route.request().headers(), body: JSON.parse(route.request().postData()) };
      return handler(route);
    });
    await page.goto(APP_URL);
    await page.setInputFiles('#scanInput', { name: 'receipt.png', mimeType: 'image/png', buffer: PNG });
    await page.waitForFunction(
      () => !document.getElementById('scanStatus').textContent.includes('Reading'),
      null, { timeout: 10000 });
    return {
      request,
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

const modelSays = text => jsonRoute(200, { content: [{ type: 'text', text }] });

test('the request carries the headers the Messages API requires', async () => {
  const r = await scan(modelSays('{"name":"Bosch dishwasher","price":899,"date":"2026-02-14","store":"Lowes","months":24,"category":"Appliances"}'));
  assert.equal(r.request.headers['anthropic-version'], '2023-06-01');
  assert.equal(r.request.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(r.request.headers['content-type'], 'application/json');
  assert.equal(r.request.body.model, 'claude-sonnet-5');
  assert.ok(r.request.body.messages[0].content.some(c => c.type === 'image'), 'the image is attached');
});

test('a successful scan fills every field', async () => {
  const r = await scan(modelSays('{"name":"Bosch dishwasher","price":899,"date":"2026-02-14","store":"Lowes","months":24,"category":"Appliances"}'));
  assert.match(r.status, /Fields filled/);
  assert.deepEqual(r.fields, {
    name: 'Bosch dishwasher', price: '899', date: '2026-02-14',
    store: 'Lowes', cat: 'Appliances', months: '24'
  });
  assert.deepEqual(r.errors, []);
});

test('an API error reports its own message, not a JSON parse error', async () => {
  const r = await scan(jsonRoute(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
  assert.match(r.status, /invalid x-api-key/);
  assert.doesNotMatch(r.status, /Unexpected end of JSON input/);
  assert.match(r.status, /enter it by hand/, 'manual entry is still offered');
});

test('a non-JSON error body still reports the status code', async () => {
  const r = await scan(route => route.fulfill({ status: 503, contentType: 'text/html', body: '<html>gateway</html>' }));
  assert.match(r.status, /503/);
  assert.doesNotMatch(r.status, /Unexpected/);
  assert.deepEqual(r.errors, []);
});

test('a non-receipt image is reported plainly', async () => {
  const r = await scan(modelSays('{"error":"not a receipt"}'));
  assert.match(r.status, /does not look like a receipt/);
});

test('unparseable model output does not leak a parser error', async () => {
  const r = await scan(modelSays('Sure! Here you go:'));
  assert.match(r.status, /could not be read from that image/);
  assert.doesNotMatch(r.status, /JSON/);
});

test('an empty response is reported', async () => {
  const r = await scan(jsonRoute(200, { content: [] }));
  assert.match(r.status, /empty response/);
});

test('a network failure is caught', async () => {
  const r = await scan(route => route.abort('failed'));
  assert.match(r.status, /Scan failed/);
  assert.match(r.status, /enter it by hand/);
  assert.deepEqual(r.errors, []);
});

test('every failure message reads as one sentence', async () => {
  for(const handler of [
    jsonRoute(401, { error: { message: 'invalid x-api-key' } }),
    route => route.abort('failed')
  ]){
    const r = await scan(handler);
    assert.match(r.status, /^Scan failed — .+\. You can still enter it by hand\.$/, r.status);
  }
});

test('a category outside the fixed list is ignored', async () => {
  const r = await scan(modelSays('{"name":"Mystery","category":"Spaceships","months":999}'));
  assert.equal(r.fields.cat, 'Electronics', 'the select keeps its default');
  assert.equal(r.fields.months, '12', 'an unlisted warranty length is ignored');
  assert.equal(r.fields.name, 'Mystery', 'valid fields still apply');
});
