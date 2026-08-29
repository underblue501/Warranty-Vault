import test from 'node:test';
import assert from 'node:assert/strict';
import { withPage } from './helpers.js';

async function fill(page, { name, price = '100', date = '2026-01-31', months = null, store = '' }){
  await page.fill('#fName', name);
  await page.fill('#fPrice', price);
  await page.fill('#fDate', date);
  if(months) await page.selectOption('#fMonths', months);
  if(store) await page.fill('#fStore', store);
}

test('pressing Enter in a field files the item', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    await fill(page, { name: 'Dyson V15' });
    await page.focus('#fName');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.receipt', { timeout: 5000 });
    assert.deepEqual(await page.locator('.rc-name').allTextContents(), ['Dyson V15']);
    assert.deepEqual(page.uncaughtErrors, []);
  });
});

test('submitting does not reload the page', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    await page.evaluate(() => { window.__stillHere = true; });
    await fill(page, { name: 'Kettle' });
    await page.focus('#fName');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.receipt');
    assert.equal(await page.evaluate(() => window.__stillHere), true,
      'the form navigated instead of being handled in place');
  });
});

test('the price field refuses a negative amount', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    assert.equal(await page.getAttribute('#fPrice', 'min'), '0');
    assert.equal(await page.getAttribute('#fPrice', 'step'), '0.01');

    // min="0" makes the browser's own constraint validation reject it, so the
    // submit handler never runs and nothing is filed.
    await fill(page, { name: 'Bad price', price: '-50' });
    await page.click('#addBtn');
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => document.getElementById('fPrice').checkValidity()), false);
    assert.equal(await page.locator('.receipt').count(), 0, 'nothing was filed');

    // A value that overflows to Infinity is rejected the same way.
    await page.fill('#fPrice', '1e999');
    await page.click('#addBtn');
    await page.waitForTimeout(150);
    assert.equal(await page.locator('.receipt').count(), 0);
  });
});

test('the submit handler guards the price even when validation is skipped', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    // A programmatic submit bypasses constraint validation, so the handler is
    // the backstop behind the min attribute.
    const alerted = await page.evaluate(() => new Promise(resolve => {
      const original = window.alert;
      window.alert = m => { window.alert = original; resolve(m); };
      document.getElementById('fName').value = 'Sneaky';
      document.getElementById('fDate').value = '2026-01-31';
      document.getElementById('fPrice').value = '-50';
      document.getElementById('addForm').dispatchEvent(new Event('submit', { cancelable: true }));
      setTimeout(() => { window.alert = original; resolve(null); }, 1000);
    }));
    assert.ok(alerted, 'the handler rejected it');
    assert.match(alerted, /not be negative|not negative/i, `got: ${alerted}`);
    assert.equal(await page.evaluate(() => items.length), 0, 'nothing was stored');
  });
});

test('price is stored as a number, not a string', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    await fill(page, { name: 'Bosch dishwasher', price: '899.50' });
    await page.click('#addBtn');
    const stored = await page.evaluate(() => items[0]);
    assert.equal(typeof stored.price, 'number');
    assert.equal(stored.price, 899.5);
    assert.equal(typeof stored.months, 'number', 'the warranty term is numeric too');
  });
});

test('an empty price stays empty rather than becoming zero', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    await fill(page, { name: 'No price', price: '' });
    await page.click('#addBtn');
    const stored = await page.evaluate(() => items[0]);
    assert.equal(stored.price, null);
    assert.match(await page.textContent('.rc-price'), /\$0/, 'it still renders as $0');
  });
});

test('filing the same item twice asks first', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    await fill(page, { name: 'Dyson V15', date: '2026-01-31' });
    await page.click('#addBtn');

    let asked = null;
    page.on('dialog', d => { asked = d.message(); d.dismiss(); });
    await fill(page, { name: 'Dyson V15', date: '2026-01-31' });
    await page.click('#addBtn');
    await page.waitForTimeout(200);

    assert.ok(asked, 'a duplicate warning was shown');
    assert.match(asked, /already in the vault/);
    assert.equal(await page.locator('.receipt').count(), 1, 'dismissing avoids the duplicate');
  });
});

test('a duplicate can still be filed deliberately', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    await fill(page, { name: 'Dyson V15', date: '2026-01-31' });
    await page.click('#addBtn');
    page.on('dialog', d => d.accept());
    await fill(page, { name: 'dyson v15', date: '2026-01-31' });   // case-insensitive match
    await page.click('#addBtn');
    await page.waitForFunction(() => document.querySelectorAll('.receipt').length === 2);
    assert.equal(await page.locator('.receipt').count(), 2);
  });
});

test('a different date is not treated as a duplicate', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    await fill(page, { name: 'Dyson V15', date: '2026-01-31' });
    await page.click('#addBtn');
    let asked = false;
    page.on('dialog', () => { asked = true; });
    await fill(page, { name: 'Dyson V15', date: '2026-02-28' });
    await page.click('#addBtn');
    await page.waitForFunction(() => document.querySelectorAll('.receipt').length === 2);
    assert.equal(asked, false, 'a genuinely different purchase was not questioned');
  });
});

test('extending coverage keeps the original term recoverable', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    const soon = await page.evaluate(() => {
      const t = new Date();
      return toISODate(new Date(t.getFullYear(), t.getMonth() - 12, t.getDate() + 10));
    });
    await fill(page, { name: 'Expiring soon', date: soon, months: '12' });
    await page.click('#addBtn');
    await page.click('button[data-extend]');
    await page.waitForSelector('.extended-note');

    const it = await page.evaluate(() => items[0]);
    assert.equal(it.baseMonths, 12, 'the manufacturer term is preserved');
    assert.equal(it.extensionMonths, 12, 'the purchased extension is recorded');
    assert.equal(it.months, 24, 'total coverage is the sum');
    assert.match(await page.textContent('.extended-note'), /12 months manufacturer \+ 12 months partner plan/);

    // The offer is gated on !it.extended, so a second extension is not
    // reachable from the UI; the offer is gone once coverage is extended.
    assert.equal(await page.locator('button[data-extend]').count(), 0);
  });
});

test('an item extended under the old scheme still renders', async () => {
  await withPage({
    timezoneId: 'UTC',
    init: () => {
      // No baseMonths/extensionMonths, as stored before those were recorded.
      const legacy = [{ id: 1, name: 'Legacy', price: '300', date: '2026-01-31',
                        months: 24, store: '', cat: 'Tools', extended: true }];
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: { getItem: k => k === 'vault-items' ? JSON.stringify(legacy) : null,
                 setItem: () => {}, removeItem: () => {} }
      });
    }
  }, async page => {
    await page.waitForSelector('.receipt');
    assert.match(await page.textContent('.extended-note'), /Coverage extended/);
    assert.match(await page.textContent('.rc-meta'), /Jan 31, 2028/, 'total coverage still reads correctly');
    assert.deepEqual(page.uncaughtErrors, []);
  });
});
