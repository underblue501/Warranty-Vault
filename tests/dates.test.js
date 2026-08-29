import test from 'node:test';
import assert from 'node:assert/strict';
import { withPage } from './helpers.js';

/* A date-only string parses as UTC midnight but renders in local time, so
   every timezone west of UTC used to display the previous day. These run in
   zones on both sides of UTC, including a +14 zone and a half-hour offset. */
const ZONES = [
  'America/Los_Angeles',   // UTC-7/8, where the off-by-one was worst
  'America/New_York',
  'UTC',
  'Asia/Tokyo',
  'Australia/Lord_Howe',   // half-hour offset
  'Pacific/Kiritimati'     // UTC+14
];

for(const timezoneId of ZONES){
  test(`dates round-trip unshifted in ${timezoneId}`, async () => {
    await withPage({ timezoneId }, async page => {
      const r = await page.evaluate(() => ({
        roundTrip: toISODate(parseLocalDate('2026-08-29')),
        rendered:  buyDate({ date: '2026-08-29' }),
        newYear:   toISODate(parseLocalDate('2026-01-01')),
        yearEnd:   toISODate(parseLocalDate('2026-12-31'))
      }));
      assert.equal(r.roundTrip, '2026-08-29');
      assert.equal(r.rendered, '8/29/2026', 'displayed date must match the stored date');
      assert.equal(r.newYear, '2026-01-01');
      assert.equal(r.yearEnd, '2026-12-31');
    });
  });

  test(`the purchase-date field prefills local today in ${timezoneId}`, async () => {
    await withPage({ timezoneId }, async page => {
      const [field, localToday] = await Promise.all([
        page.inputValue('#fDate'),
        page.evaluate(() => toISODate(new Date()))
      ]);
      // .valueAsDate reads UTC components and could offer tomorrow late in the day.
      assert.equal(field, localToday);
    });
  });
}

test('month arithmetic clamps to the end of the target month', async () => {
  await withPage({ timezoneId: 'America/New_York' }, async page => {
    const r = await page.evaluate(() => ({
      janToFeb:  toISODate(endDateObj({ date: '2026-01-31', months: 1 })),
      leap:      toISODate(endDateObj({ date: '2024-01-31', months: 1 })),
      may31:     toISODate(endDateObj({ date: '2026-05-31', months: 1 })),
      twelve:    toISODate(endDateObj({ date: '2026-08-29', months: 12 })),
      sixty:     toISODate(endDateObj({ date: '2026-02-29', months: 60 }))
    }));
    assert.equal(r.janToFeb, '2026-02-28', 'Jan 31 + 1 month must not overflow into March');
    assert.equal(r.leap, '2024-02-29');
    assert.equal(r.may31, '2026-06-30');
    assert.equal(r.twelve, '2027-08-29');
    assert.equal(r.sixty, '2031-03-01');
  });
});

test('coverage runs through the final day, not up to it', async () => {
  await withPage({ timezoneId: 'America/Los_Angeles' }, async page => {
    const r = await page.evaluate(() => {
      const shift = n => { const t = new Date(); return toISODate(new Date(t.getFullYear(), t.getMonth() - 12, t.getDate() + n)); };
      return {
        endsToday:     daysLeft({ date: shift(0),  months: 12 }),
        endedYesterday:daysLeft({ date: shift(-1), months: 12 }),
        endsTomorrow:  daysLeft({ date: shift(1),  months: 12 })
      };
    });
    assert.equal(r.endsToday, 0, 'an item whose coverage ends today is still covered');
    assert.equal(r.endedYesterday, -1);
    assert.equal(r.endsTomorrow, 1);
  });
});

test('a warranty spanning a DST transition counts whole days', async () => {
  await withPage({ timezoneId: 'America/New_York' }, async page => {
    // 2026-03-08 and 2026-11-01 are the US DST transitions.
    const r = await page.evaluate(() => ({
      across: Math.round((endDateObj({ date: '2026-03-01', months: 1 }) - parseLocalDate('2026-03-01')) / 86400000),
      back:   Math.round((endDateObj({ date: '2026-10-15', months: 1 }) - parseLocalDate('2026-10-15')) / 86400000)
    }));
    assert.equal(r.across, 31, 'spring-forward month is still 31 whole days');
    assert.equal(r.back, 31, 'fall-back month is still 31 whole days');
  });
});

test('unusable dates degrade instead of throwing', async () => {
  await withPage({ timezoneId: 'UTC' }, async page => {
    const r = await page.evaluate(() => ({
      empty:   daysLeft({ date: '', months: 12 }),
      missing: daysLeft({ months: 12 }),
      garbage: endDate({ date: 'not-a-date', months: 12 }),
      buy:     buyDate({ date: 'not-a-date' }),
      parsed:  parseLocalDate('2026-13-45') === null ? 'null' : toISODate(parseLocalDate('2026-13-45'))
    }));
    assert.equal(r.empty, -1);
    assert.equal(r.missing, -1);
    assert.equal(r.garbage, '—');
    assert.equal(r.buy, '—');
    assert.equal(r.parsed, '2027-02-14', 'out-of-range parts roll over rather than crash');
  });
});
