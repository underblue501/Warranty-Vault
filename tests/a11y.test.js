import test from 'node:test';
import assert from 'node:assert/strict';
import { withPage } from './helpers.js';

/* Reads the colours the browser actually renders rather than hex literals, so
   the thresholds keep holding if the palette is retuned later. */
async function ratios(page, selectors){
  return page.evaluate(sels => {
    const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const parse = s => (s.match(/[\d.]+/g) || []).map(Number);
    const lum = rgb => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
    const opaque = s => s && s !== 'transparent' && !/rgba\([^)]*,\s*0\s*\)/.test(s);

    // An element's own background may be transparent; the painted colour is
    // the nearest opaque ancestor.
    const bgOf = el => {
      for(let n = el; n; n = n.parentElement){
        const b = getComputedStyle(n).backgroundColor;
        if(opaque(b)) return parse(b);
      }
      return [255, 255, 255];
    };

    const out = {};
    for(const name of Object.keys(sels)){
      const el = document.querySelector(sels[name]);
      if(!el){ out[name] = null; continue; }
      const a = lum(parse(getComputedStyle(el).color));
      const b = lum(bgOf(el));
      out[name] = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    }
    return out;
  }, selectors);
}

async function seedExpiringItem(page){
  // An item inside its final 30 days renders the amber stamp and the offer.
  const soon = await page.evaluate(() => {
    const t = new Date();
    return toISODate(new Date(t.getFullYear(), t.getMonth() - 12, t.getDate() + 10));
  });
  await page.fill('#fName', 'Expiring soon');
  await page.fill('#fPrice', '400');
  await page.fill('#fDate', soon);
  await page.click('#addBtn');
}

test('the amber warning state meets WCAG AA', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    await seedExpiringItem(page);
    const r = await ratios(page, {
      stamp:       '.stamp.warn',
      alertLabel:  '.alerts b',
      offerLabel:  '.offer p b',
      offerButton: '.offer button'
    });
    for(const [name, value] of Object.entries(r)){
      assert.ok(value !== null, `${name} was not rendered, so it went unchecked`);
      // 11px bold is not "large text", so the 4.5:1 threshold applies.
      assert.ok(value >= 4.5, `${name} is ${value.toFixed(2)}:1, below the 4.5:1 minimum`);
    }
  });
});

test('the other status colours stay above the threshold', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    await page.fill('#fName', 'Covered');
    await page.fill('#fDate', await page.evaluate(() => toISODate(new Date())));
    await page.click('#addBtn');
    const safe = await ratios(page, { stamp: '.stamp.safe', meta: '.rc-meta', price: '.rc-price' });
    for(const [name, value] of Object.entries(safe)){
      assert.ok(value >= 4.5, `${name} is ${value.toFixed(2)}:1`);
    }

    await page.fill('#fName', 'Lapsed');
    await page.fill('#fDate', '2020-01-01');
    await page.click('#addBtn');
    const dead = await ratios(page, { stamp: '.stamp.dead' });
    assert.ok(dead.stamp >= 4.5, `expired stamp is ${dead.stamp.toFixed(2)}:1`);
  });
});

test('text on the dark page background stays legible', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    const r = await ratios(page, { empty: '#emptyMsg', brand: '.brand' });
    assert.ok(r.empty >= 4.5, `empty-state text is ${r.empty.toFixed(2)}:1`);
    assert.ok(r.brand >= 4.5, `brand text is ${r.brand.toFixed(2)}:1`);
  });
});

test('the vault tools and import status stay legible on the dark ground', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    const idle = await ratios(page, { importBtn: '#importBtn' });
    assert.ok(idle.importBtn >= 4.5, `import button is ${idle.importBtn.toFixed(2)}:1`);

    // Success wording.
    await page.setInputFiles('#importInput', {
      name: 'b.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ items: [{ id: 'a', name: 'X', date: '2026-01-31', months: 12 }] }))
    });
    await page.waitForFunction(() => document.getElementById('importStatus').classList.contains('ok'));
    const ok = await ratios(page, { status: '#importStatus' });
    assert.ok(ok.status >= 4.5, `import success text is ${ok.status.toFixed(2)}:1`);

    // Failure wording.
    await page.setInputFiles('#importInput', {
      name: 'x.txt', mimeType: 'application/json', buffer: Buffer.from('not json')
    });
    await page.waitForFunction(() => document.getElementById('importStatus').classList.contains('err'));
    const err = await ratios(page, { status: '#importStatus' });
    assert.ok(err.status >= 4.5, `import error text is ${err.status.toFixed(2)}:1`);
  });
});
