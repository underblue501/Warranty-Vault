import test from 'node:test';
import assert from 'node:assert/strict';
import { withPage } from './helpers.js';

async function fileItem(page, name, date = '2026-01-31', cat = null){
  await page.fill('#fName', name);
  await page.fill('#fPrice', '100');
  await page.fill('#fDate', date);
  if(cat) await page.selectOption('#fCat', cat);
  await page.click('#addBtn');
}

const names = page => page.locator('.rc-name').allTextContents();

test('removing an item asks first, and a dismissal keeps it', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    await fileItem(page, 'Dyson V15');

    let asked = null;
    page.on('dialog', d => { asked = d.message(); d.dismiss(); });
    await page.click('button[data-del]');
    await page.waitForTimeout(200);

    assert.ok(asked, 'a confirmation was shown');
    assert.match(asked, /Dyson V15/, 'the prompt names the item being removed');
    assert.match(asked, /cannot be undone/);
    assert.deepEqual(await names(page), ['Dyson V15'], 'dismissing keeps the item');
  });
});

test('confirming removes only the item that was clicked', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    await fileItem(page, 'Keep me', '2026-01-31');
    await fileItem(page, 'Remove me', '2026-02-28');

    page.on('dialog', d => d.accept());
    const target = page.locator('.receipt', { hasText: 'Remove me' }).locator('button[data-del]');
    await target.click();
    await page.waitForFunction(() => document.querySelectorAll('.receipt').length === 1);

    assert.deepEqual(await names(page), ['Keep me']);
    await page.reload();
    assert.deepEqual(await names(page), ['Keep me'], 'the removal persisted');
  });
});

test('the vault exports as JSON', async () => {
  await withPage({ timezoneId: 'UTC', acceptDownloads: true }, async page => {
    await fileItem(page, 'Bosch dishwasher', '2026-01-31', 'Appliances');
    await fileItem(page, 'Dyson V15', '2026-02-28');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#exportBtn')
    ]);
    assert.match(download.suggestedFilename(), /^warranty-vault-\d{4}-\d{2}-\d{2}\.json$/,
      `unexpected filename: ${download.suggestedFilename()}`);

    let body = '';
    for await (const chunk of await download.createReadStream()) body += chunk;
    const parsed = JSON.parse(body);
    assert.equal(parsed.app, 'warranty-vault');
    assert.equal(parsed.version, 1);
    assert.equal(parsed.items.length, 2);
    assert.deepEqual(parsed.items.map(i => i.name).sort(), ['Bosch dishwasher', 'Dyson V15']);

    const bosch = parsed.items.find(i => i.name === 'Bosch dishwasher');
    assert.equal(bosch.date, '2026-01-31', 'the stored date is exported verbatim');
    assert.equal(bosch.cat, 'Appliances');
    assert.ok(bosch.id, 'each item carries its id, so an export can be restored');
  });
});

test('activating a category chip keeps keyboard focus on it', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    await fileItem(page, 'Bosch dishwasher', '2026-01-31', 'Appliances');
    await fileItem(page, 'Dyson V15', '2026-02-28', 'Electronics');

    const chip = '.chip[data-cat="Appliances"]';
    await page.focus(chip);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.receipt').length === 1);

    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      return { tag: el.tagName, cat: el.dataset ? el.dataset.cat : null };
    });
    assert.equal(focused.tag, 'BUTTON', 'focus did not fall back to the body');
    assert.equal(focused.cat, 'Appliances', 'focus stayed on the chip that was activated');
    assert.equal(await page.locator(chip + '.on').count(), 1, 'the chip shows as selected');
  });
});

test('typing in the search box does not disturb the chips', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    await fileItem(page, 'Bosch dishwasher', '2026-01-31', 'Appliances');
    // Stash the node BEFORE the keystroke; a rebuilt chip is a different object.
    await page.evaluate(() => {
      window.__chipBefore = document.querySelector('.chip[data-cat="Appliances"]');
    });
    await page.fill('#search', 'bosch');
    const sameNode = await page.evaluate(() =>
      window.__chipBefore === document.querySelector('.chip[data-cat="Appliances"]'));
    assert.ok(sameNode, 'the chip element survived a search keystroke');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'search');
  });
});

test('ids are unique, not a timestamp two items can share', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    const distinct = await page.evaluate(() => {
      const seen = new Set();
      for(let i = 0; i < 5000; i++) seen.add(newId());
      return seen.size;
    });
    assert.equal(distinct, 5000, 'newId() collided within a tight loop');

    await fileItem(page, 'First', '2026-01-31');
    await fileItem(page, 'Second', '2026-02-28');
    const ids = await page.evaluate(() => items.map(i => String(i.id)));
    assert.equal(new Set(ids).size, 2, 'two items filed back to back got distinct ids');
    assert.ok(!ids.every(id => /^\d{13}$/.test(id)), 'ids are no longer bare millisecond timestamps');
  });
});
