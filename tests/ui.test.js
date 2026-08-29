import test from 'node:test';
import assert from 'node:assert/strict';
import { withPage } from './helpers.js';

async function fileItem(page, { name, price = '649', date, months = '12', store = 'Best Buy' }){
  await page.fill('#fName', name);
  await page.fill('#fPrice', price);
  await page.fill('#fDate', date);
  await page.selectOption('#fMonths', months);
  await page.fill('#fStore', store);
  await page.click('#addBtn');
}

test('the claim letter quotes the same date as the card', async () => {
  await withPage({ timezoneId: 'America/Los_Angeles' }, async page => {
    await fileItem(page, { name: 'Dyson V15', date: '2026-01-31' });
    assert.ok((await page.textContent('.rc-meta')).includes('1/31/2026'));

    await page.click('button.claim');
    const letter = await page.textContent('#letterText');
    assert.match(letter, /Purchase date:   1\/31\/2026/);
    assert.match(letter, /Coverage ends:   Jan 31, 2027/);
    assert.match(letter, /Item:            Dyson V15/);
    assert.ok(await page.locator('#downloadBtn').isHidden(), 'no .ics download on the letter view');
  });
});

test('the reminder downloads as a real .ics file', async () => {
  await withPage({ timezoneId: 'America/Los_Angeles', acceptDownloads: true }, async page => {
    await fileItem(page, { name: 'Dyson V15, refurbished', date: '2026-01-31' });
    await page.click('button[data-remind]');
    assert.ok(await page.locator('#downloadBtn').isVisible());

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#downloadBtn')
    ]);
    assert.equal(download.suggestedFilename(), 'Dyson-V15-refurbished.ics');

    let body = '';
    for await (const chunk of await download.createReadStream()) body += chunk;
    assert.match(body, /DTSTAMP:\d{8}T\d{6}Z/);
    assert.ok(body.includes('DTSTART;VALUE=DATE:20270117'));
    assert.ok(body.includes('Dyson V15\\, refurbished'), 'the comma is escaped in the saved file');
  });
});

test('copying reports an outcome even where the clipboard API is unavailable', async () => {
  // A file:// origin is not a secure context, so navigator.clipboard is absent.
  await withPage({ timezoneId: 'UTC' }, async page => {
    await fileItem(page, { name: 'Kettle', date: '2026-01-31' });
    await page.click('button.claim');
    const btn = page.locator('#copyBtn');
    const original = await btn.textContent();
    await btn.click();
    await page.waitForFunction(
      t => document.getElementById('copyBtn').textContent !== t, original, { timeout: 5000 });
    const label = await btn.textContent();
    assert.ok(['Copied ✓', 'Press Ctrl/⌘+C to copy'].includes(label), `unexpected label: ${label}`);
    assert.deepEqual(page.uncaughtErrors, [], 'the clipboard path throws nothing');
  });
});

test('an item on its final day reads as covered, not expired', async () => {
  await withPage({ timezoneId: 'America/Los_Angeles' }, async page => {
    const lastDay = await page.evaluate(() => {
      const t = new Date();
      return toISODate(new Date(t.getFullYear(), t.getMonth() - 12, t.getDate()));
    });
    await fileItem(page, { name: 'Edge case', date: lastDay });
    const stamp = await page.textContent('.stamp');
    assert.match(stamp, /Last day/);
    assert.equal(await page.textContent('#stSoon'), '1', 'it counts toward expiring soon');
    assert.equal(await page.textContent('#stValue'), '$649', 'its value still counts as covered');
  });
});

test('search and category filters narrow the list', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    await fileItem(page, { name: 'Dyson vacuum', date: '2026-01-31', store: 'Best Buy' });
    await page.selectOption('#fCat', 'Appliances');
    await fileItem(page, { name: 'Bosch dishwasher', date: '2026-02-01', store: 'Lowes' });
    assert.equal(await page.locator('.receipt').count(), 2);

    await page.fill('#search', 'bosch');
    assert.equal(await page.locator('.receipt').count(), 1);
    await page.fill('#search', 'lowes');
    assert.equal(await page.locator('.receipt').count(), 1, 'retailer is searchable');
    await page.fill('#search', 'zzz');
    assert.equal(await page.locator('.receipt').count(), 0);
    assert.match(await page.textContent('.empty'), /Nothing in the vault matches/);

    await page.fill('#search', '');
    await page.click('.chip[data-cat="Appliances"]');
    assert.equal(await page.locator('.receipt').count(), 1);
    assert.deepEqual(page.uncaughtErrors, []);
  });
});

test('item names are escaped, not rendered as markup', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    await fileItem(page, { name: '<img src=x onerror="window.__xss=1">', date: '2026-01-31' });
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.equal(await page.locator('.rc-name img').count(), 0);
    assert.match(await page.textContent('.rc-name'), /<img src=x/);
  });
});
