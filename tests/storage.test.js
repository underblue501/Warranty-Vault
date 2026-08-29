import test from 'node:test';
import assert from 'node:assert/strict';
import { withPage } from './helpers.js';

/* Each test replaces localStorage via addInitScript, before any app code runs,
   so the app sees the failure mode a real browser produces in private mode or
   at quota. */

test('a healthy save persists across a reload and shows no notice', async () => {
  await withPage({ timezoneId: 'America/Los_Angeles' }, async page => {
    await page.fill('#fName', 'Bosch dishwasher');
    await page.fill('#fPrice', '899');
    await page.fill('#fDate', '2026-01-31');
    await page.selectOption('#fMonths', '24');
    await page.fill('#fStore', 'Lowes');
    await page.click('#addBtn');

    await page.reload();
    assert.equal(await page.textContent('#stCount'), '1');
    const meta = await page.textContent('.rc-meta');
    assert.ok(meta.includes('1/31/2026'), `purchase date survives a reload: ${meta}`);
    assert.ok(meta.includes('Jan 31, 2028'), `24-month coverage end survives: ${meta}`);
    assert.equal(await page.locator('#notice').isVisible(), false, 'no error notice on a healthy save');
    assert.deepEqual(page.uncaughtErrors, []);
  });
});

test('a save that throws is surfaced, not swallowed', async () => {
  await withPage({
    timezoneId: 'UTC',
    init: () => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: {
          getItem: () => null,
          setItem: () => { throw new DOMException('quota exceeded', 'QuotaExceededError'); },
          removeItem: () => {}
        }
      });
    }
  }, async page => {
    await page.fill('#fName', 'Test kettle');
    await page.fill('#fDate', '2026-03-01');
    await page.click('#addBtn');
    assert.ok(await page.locator('#notice').isVisible(), 'the notice banner appears');
    const note = await page.textContent('#notice');
    assert.match(note, /Not saved/, note);
    assert.match(note, /quota exceeded/, 'the underlying reason is quoted');
    assert.deepEqual(page.uncaughtErrors, []);
  });
});

test('unreadable stored data is left intact rather than overwritten', async () => {
  await withPage({
    timezoneId: 'UTC',
    init: () => {
      const store = { 'vault-items': '{{{ not json' };
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: {
          getItem: k => (k in store ? store[k] : null),
          setItem: (k, v) => { store[k] = v; },
          removeItem: k => { delete store[k]; },
          _peek: () => store['vault-items']
        }
      });
    }
  }, async page => {
    assert.ok(await page.locator('#notice').isVisible(), 'the unreadable-data notice appears on load');

    await page.fill('#fName', 'Should not clobber');
    await page.fill('#fDate', '2026-03-01');
    await page.click('#addBtn');

    const stored = await page.evaluate(() => window.localStorage._peek());
    assert.equal(stored, '{{{ not json', 'the original value is untouched after a subsequent save');
    assert.deepEqual(page.uncaughtErrors, []);
  });
});

test('a stored value of the wrong shape is treated as unreadable', async () => {
  await withPage({
    timezoneId: 'UTC',
    init: () => {
      const store = { 'vault-items': '{"not":"an array"}' };
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: {
          getItem: k => (k in store ? store[k] : null),
          setItem: (k, v) => { store[k] = v; },
          removeItem: k => { delete store[k]; },
          _peek: () => store['vault-items']
        }
      });
    }
  }, async page => {
    assert.ok(await page.locator('#notice').isVisible());
    await page.fill('#fName', 'x');
    await page.fill('#fDate', '2026-03-01');
    await page.click('#addBtn');
    assert.equal(await page.evaluate(() => window.localStorage._peek()), '{"not":"an array"}');
  });
});
