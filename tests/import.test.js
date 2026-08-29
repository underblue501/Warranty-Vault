import test from 'node:test';
import assert from 'node:assert/strict';
import { withPage } from './helpers.js';

const upload = (page, content, name = 'backup.json') =>
  page.setInputFiles('#importInput', {
    name, mimeType: 'application/json',
    buffer: Buffer.from(typeof content === 'string' ? content : JSON.stringify(content))
  });

const status = async page => {
  await page.waitForFunction(() => {
    const el = document.getElementById('importStatus');
    return el && el.style.display === 'block' && el.textContent.trim() !== '';
  }, null, { timeout: 5000 });
  return (await page.textContent('#importStatus')).trim();
};

const backup = items => ({ app: 'warranty-vault', version: 1, exported: new Date().toISOString(), items });

const ITEM = {
  id: 'aaa-1', name: 'Bosch dishwasher', price: 899, date: '2026-01-31',
  months: 24, baseMonths: 24, extensionMonths: 0, store: 'Lowes',
  cat: 'Appliances', extended: false
};

async function fileItem(page, name, date = '2026-06-01'){
  await page.fill('#fName', name);
  await page.fill('#fDate', date);
  await page.click('#addBtn');
}

test('import is reachable on an empty vault, export is not', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    assert.equal(await page.locator('#importBtn').isVisible(), true,
      'import must be reachable when restoring into a fresh browser');
    assert.equal(await page.locator('#exportBtn').isDisabled(), true);
    await fileItem(page, 'Anything');
    assert.equal(await page.locator('#exportBtn').isDisabled(), false);
  });
});

test('a backup restores into an empty vault', async () => {
  await withPage({ timezoneId: 'America/Los_Angeles' }, async page => {
    await upload(page, backup([ITEM]));
    assert.match(await status(page), /1 item imported/);
    assert.deepEqual(await page.locator('.rc-name').allTextContents(), ['Bosch dishwasher']);
    const meta = await page.textContent('.rc-meta');
    assert.ok(meta.includes('1/31/2026'), `date survived the round trip: ${meta}`);
    assert.ok(meta.includes('Jan 31, 2028'), '24-month coverage survived');

    await page.reload();
    assert.equal(await page.textContent('#stCount'), '1', 'the import persisted');
  });
});

test('an export round-trips through import unchanged', async () => {
  await withPage({ timezoneId: 'UTC', acceptDownloads: true }, async page => {
    await fileItem(page, 'Dyson V15', '2026-01-31');
    await fileItem(page, 'Patio heater', '2026-03-15');
    const before = await page.evaluate(() => JSON.parse(JSON.stringify(items)));

    const [download] = await Promise.all([
      page.waitForEvent('download'), page.click('#exportBtn')
    ]);
    let body = '';
    for await (const chunk of await download.createReadStream()) body += chunk;

    // Clear the vault, then restore from the file just produced.
    await page.evaluate(() => { items.length = 0; render(); });
    await upload(page, body);
    assert.match(await status(page), /2 items imported/);

    const after = await page.evaluate(() => items);
    assert.deepEqual(after, before, 'every field survived export and re-import');
  });
});

test('importing the same backup twice adds nothing the second time', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    await upload(page, backup([ITEM]));
    assert.match(await status(page), /1 item imported/);
    await upload(page, backup([ITEM]));
    assert.match(await status(page), /already in your vault/);
    assert.equal(await page.locator('.receipt').count(), 1, 'no duplicate was created');
  });
});

test('import merges without removing what is already there', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    await fileItem(page, 'Already mine', '2026-06-01');
    await upload(page, backup([ITEM]));
    assert.match(await status(page), /1 item imported/);
    const names = await page.locator('.rc-name').allTextContents();
    assert.equal(names.length, 2);
    assert.ok(names.includes('Already mine'), 'the existing item was not replaced');
    assert.ok(names.includes('Bosch dishwasher'));
  });
});

test('a file that is not JSON is reported, not thrown', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    await upload(page, 'this is not json at all', 'notes.txt');
    assert.match(await status(page), /not valid JSON/);
    assert.deepEqual(page.uncaughtErrors, []);
  });
});

test('valid JSON with no items is reported', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    await upload(page, { hello: 'world' });
    assert.match(await status(page), /no vault items/);
    assert.equal(await page.locator('.receipt').count(), 0);
  });
});

test('a bare array of items is accepted', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    await upload(page, [ITEM]);
    assert.match(await status(page), /1 item imported/);
  });
});

test('unusable entries are skipped rather than breaking the import', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    await upload(page, backup([
      ITEM,
      { id: 'x', name: '', date: '2026-01-01' },        // no name
      { id: 'y', name: 'No date' },                      // no date
      { id: 'z', name: 'Bad date', date: 'whenever' },   // unparseable
      null,
      'not an object'
    ]));
    const s = await status(page);
    assert.match(s, /1 item imported/);
    assert.match(s, /5 unreadable and skipped/);
    assert.equal(await page.locator('.receipt').count(), 1);
    assert.deepEqual(page.uncaughtErrors, []);
  });
});

test('hostile field values are neutralised, not trusted', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    await upload(page, backup([{
      id: 'evil-1',
      name: '<img src=x onerror="window.__xss=1">',
      store: '<script>window.__xss2=1</script>',
      date: '2026-01-31',
      price: -5000,
      months: 'not a number',
      cat: 'Spaceships',
      extended: 'yes please'
    }]));
    assert.match(await status(page), /1 item imported/);

    assert.equal(await page.evaluate(() => window.__xss), undefined, 'markup was not executed');
    assert.equal(await page.evaluate(() => window.__xss2), undefined);
    assert.equal(await page.locator('.rc-name img').count(), 0);

    const it = await page.evaluate(() => items[0]);
    assert.equal(it.cat, 'Other', 'an unknown category falls back');
    assert.equal(it.months, 12, 'a non-numeric term falls back');
    assert.equal(it.price, null, 'a negative price is rejected');
    assert.equal(it.extended, false, 'a truthy non-boolean is not treated as true');
    assert.deepEqual(page.uncaughtErrors, []);
  });
});

test('an item with no id is given one rather than colliding', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    await upload(page, backup([
      { name: 'First', date: '2026-01-31' },
      { name: 'Second', date: '2026-02-28' }
    ]));
    assert.match(await status(page), /2 items imported/);
    const ids = await page.evaluate(() => items.map(i => String(i.id)));
    assert.equal(new Set(ids).size, 2);
    assert.ok(ids.every(Boolean));
  });
});

test('import refuses while saving is paused', async () => {
  await withPage({
    timezoneId: 'UTC',
    init: () => {
      const store = { 'vault-items': '{{{ not json' };
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: { getItem: k => (k in store ? store[k] : null),
                 setItem: (k, v) => { store[k] = v; },
                 removeItem: () => {}, _peek: () => store['vault-items'] }
      });
    }
  }, async page => {
    await upload(page, backup([ITEM]));
    assert.match(await status(page), /Saving is paused/);
    assert.equal(await page.evaluate(() => window.localStorage._peek()), '{{{ not json',
      'the unreadable stored data was still not overwritten');
  });
});
