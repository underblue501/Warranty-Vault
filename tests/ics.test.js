import test from 'node:test';
import assert from 'node:assert/strict';
import { withPage } from './helpers.js';

const ITEM = { id: 123, name: 'Dyson V15, refurbished; "the good one"', date: '2026-01-31', months: 12 };

function lines(ics){ return ics.split('\r\n'); }
function unfold(ics){ return ics.replace(/\r\n /g, ''); }

test('the reminder is a valid VEVENT', async () => {
  await withPage({ timezoneId: 'America/Los_Angeles' }, async page => {
    const ics = await page.evaluate(it => buildIcs(it), ITEM);
    const l = lines(ics);
    assert.equal(l[0], 'BEGIN:VCALENDAR');
    assert.ok(l.includes('VERSION:2.0'));
    assert.ok(l.includes('BEGIN:VEVENT') && l.includes('END:VEVENT'));
    assert.equal(l.filter(Boolean).at(-1), 'END:VCALENDAR');
    // DTSTAMP is mandatory in a VEVENT; without it calendar clients reject the file.
    assert.match(ics, /\r\nDTSTAMP:\d{8}T\d{6}Z\r\n/, 'DTSTAMP present, in UTC form');
    assert.match(ics, /\r\nUID:[^\r\n]+@warrantyvault\r\n/);
    assert.ok(ics.endsWith('\r\n'), 'file ends with CRLF');
    assert.ok(!/[^\r]\n/.test(ics), 'every line break is CRLF, never a bare LF');
  });
});

test('the reminder falls 14 days before coverage ends, with an exclusive DTEND', async () => {
  await withPage({ timezoneId: 'America/Los_Angeles' }, async page => {
    const ics = await page.evaluate(it => buildIcs(it), ITEM);
    // Coverage ends 2027-01-31, so the reminder is 2027-01-17 and DTEND the 18th.
    assert.ok(ics.includes('DTSTART;VALUE=DATE:20270117'), 'DTSTART is 14 days before expiry');
    assert.ok(ics.includes('DTEND;VALUE=DATE:20270118'), 'all-day DTEND is the following day');
  });
});

test('special characters are escaped, not emitted raw', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    const r = await page.evaluate(() => ({
      comma:     icsEscape('a, b'),
      semicolon: icsEscape('a; b'),
      backslash: icsEscape('a\\b'),
      newline:   icsEscape('a\nb'),
      crlf:      icsEscape('a\r\nb'),
      quote:     icsEscape('say "hi"')
    }));
    assert.equal(r.comma, 'a\\, b');
    assert.equal(r.semicolon, 'a\\; b');
    assert.equal(r.backslash, 'a\\\\b');
    assert.equal(r.newline, 'a\\nb');
    assert.equal(r.crlf, 'a\\nb');
    assert.equal(r.quote, 'say "hi"', 'double quotes are legal unescaped in a TEXT value');
  });
});

test('an item name with a comma does not split the property', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    const ics = await page.evaluate(it => buildIcs(it), ITEM);
    const summary = unfold(ics).split('\r\n').find(l => l.startsWith('SUMMARY:'));
    assert.equal(summary, 'SUMMARY:Warranty ending soon: Dyson V15\\, refurbished\\; "the good one"');
  });
});

test('lines fold at 75 octets and unfold losslessly', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    const r = await page.evaluate(() => {
      const longName = 'Ultra Premium Stainless Steel Countertop Dishwasher Model XJ-9000 Deluxe Edition';
      const accents  = 'é'.repeat(90);
      const ics = buildIcs({ id: 1, name: longName, date: '2026-01-31', months: 12 });
      return {
        ics,
        over: ics.split('\r\n').filter(l => new TextEncoder().encode(l).length > 75),
        asciiRoundTrip:  icsFold('SUMMARY:' + longName).replace(/\r\n /g, '') === 'SUMMARY:' + longName,
        accentRoundTrip: icsFold('SUMMARY:' + accents).replace(/\r\n /g, '') === 'SUMMARY:' + accents,
        continuationsIndented: icsFold('SUMMARY:' + accents).split('\r\n').slice(1).every(l => l.startsWith(' '))
      };
    });
    assert.deepEqual(r.over, [], 'no line exceeds 75 octets');
    assert.ok(r.asciiRoundTrip, 'folding an ASCII line is reversible');
    assert.ok(r.accentRoundTrip, 'folding never splits a multi-byte UTF-8 sequence');
    assert.ok(r.continuationsIndented, 'continuation lines begin with a space');
    assert.ok(unfold(r.ics).includes('Model XJ-9000 Deluxe Edition'));
  });
});

test('an item with an unusable date builds no reminder', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    const r = await page.evaluate(() => buildIcs({ id: 1, name: 'x', date: '', months: 12 }));
    assert.equal(r, null);
  });
});
