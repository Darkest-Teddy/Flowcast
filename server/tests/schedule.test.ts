import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app';
import type { CampusModel } from '../src/campus';
import { previewSchedule, scheduleWindow, validateSchedule } from '../src/dashboard/schedule';

const now = new Date('2026-10-24T16:00:00Z');
const locations = [{ id: 'cas', name: 'College of Arts and Sciences', short: 'CAS' }];
const calendar = (...events: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events, 'END:VCALENDAR'].join('\r\n');
const event = (properties: string) => `BEGIN:VEVENT\r\n${properties}\r\nEND:VEVENT`;
const base = 'UID:class\r\nSUMMARY:Math\r\nDTSTART;TZID=America/New_York:20261025T090000\r\nDURATION:PT1H\r\nLOCATION:CAS 101';
const preview = (content: string, at = now, catalog = locations) => previewSchedule({ fileName: 'classes.ics', content }, catalog, at);

test('Boston window includes today and ends at local midnight after 120 calendar days', () => {
  assert.deepEqual(scheduleWindow(now), { windowStart: '2026-10-24T04:00:00.000Z', windowEnd: '2027-02-21T05:00:00.000Z' });
  assert.equal(scheduleWindow(new Date('2026-11-01T23:00:00Z')).windowStart, '2026-11-01T04:00:00.000Z');
  assert.equal(scheduleWindow(new Date('2026-03-08T23:00:00Z')).windowStart, '2026-03-08T05:00:00.000Z');
});

test('weekly recurrence preserves wall-clock time over fall DST and DURATION', async () => {
  const p = await preview(calendar(event(`${base}\r\nRRULE:FREQ=WEEKLY;COUNT=3`)));
  assert.deepEqual(p.items.map((i) => i.start), ['2026-10-25T13:00:00.000Z', '2026-11-01T14:00:00.000Z', '2026-11-08T14:00:00.000Z']);
  assert.ok(p.items.every((i) => Date.parse(i.end) - Date.parse(i.start) === 3600000 && i.locationId === 'cas'));
  assert.equal(p.items[0].locationText, 'CAS 101');
  assert.deepEqual(p.warnings, []);
});

test('Google and Outlook VTIMEZONE observances do not become floating Boston event times', async () => {
  for (const zone of ['America/New_York', 'Eastern Standard Time']) {
    const timezone = ['BEGIN:VTIMEZONE', `TZID:${zone}`, 'BEGIN:STANDARD', 'DTSTART:16011104T020000', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11', 'END:STANDARD', 'BEGIN:DAYLIGHT', 'DTSTART:16010311T020000', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'RRULE:FREQ=YEARLY;BYDAY=2SU;BYMONTH=3', 'END:DAYLIGHT', 'END:VTIMEZONE'].join('\r\n');
    const p = await preview(calendar(timezone, event(base.replace('America/New_York', zone) + '\r\nRRULE:FREQ=WEEKLY;COUNT=3')));
    assert.deepEqual(p.items.map((i) => i.start), ['2026-10-25T13:00:00.000Z', '2026-11-01T14:00:00.000Z', '2026-11-08T14:00:00.000Z']);
    assert.deepEqual(p.warnings, []);
  }
});

test('spring DST, EXDATE, rescheduled and cancelled recurrence exceptions', async () => {
  const p = await preview(calendar(
    event('UID:spring\r\nSUMMARY:Seminar\r\nDTSTART;TZID=America/New_York:20260301T090000\r\nDURATION:PT90M\r\nRRULE:FREQ=WEEKLY;COUNT=5\r\nEXDATE;TZID=America/New_York:20260315T090000'),
    event('UID:spring\r\nRECURRENCE-ID;TZID=America/New_York:20260322T090000\r\nDTSTART;TZID=America/New_York:20260323T100000\r\nDURATION:PT2H\r\nSUMMARY:Moved'),
    event('UID:spring\r\nRECURRENCE-ID;TZID=America/New_York:20260329T090000\r\nSTATUS:CANCELLED'),
  ), new Date('2026-03-01T12:00:00Z'));
  assert.deepEqual(p.items.map((i) => i.start), ['2026-03-01T14:00:00.000Z', '2026-03-08T13:00:00.000Z', '2026-03-23T14:00:00.000Z']);
  assert.equal(p.items[2].title, 'Moved'); assert.equal(p.items[2].end, '2026-03-23T16:00:00.000Z');
});

test('floating times disclose Boston, all-day skipped, cancelled series omitted, ambiguous mappings stay empty', async () => {
  const p = await preview(calendar(event(base.replace(';TZID=America/New_York', '')), event('UID:all\r\nDTSTART;VALUE=DATE:20261026\r\nDTEND;VALUE=DATE:20261027'), event(base.replace('UID:class', 'UID:cancel') + '\r\nSTATUS:CANCELLED')), now, [...locations, { id: 'other', name: 'Other', short: 'CAS' }]);
  assert.equal(p.items.length, 1); assert.equal(p.items[0].start, '2026-10-25T13:00:00.000Z');
  assert.equal(p.items[0].locationId, '');
  assert.ok(p.warnings.some((w) => w.includes('Boston'))); assert.ok(p.warnings.some((w) => w.includes('All-day')));
});

test('malformed, oversized, unsupported timezone and expensive recurrence input fail closed', async () => {
  for (const content of [
    'garbage', calendar(event(base)).replace('END:VCALENDAR', ''), calendar(event(base.replace('America/New_York', 'Unknown/Zone'))),
    calendar(event(base.replace('20261025', '20260230'))), calendar(event(base), event(base)),
    calendar(event(`${base}\r\nRRULE:FREQ=SECONDLY`)), calendar(event(`${base}\r\nRDATE:20261026T090000Z`)),
    calendar(event(`${base}\r\nRRULE:FREQ=WEEKLY;INTERVAL=0`)), calendar(event(`${base}\r\nRRULE:FREQ=WEEKLY;COUNT=oops`)),
    calendar(event(base.replace('PT1H', 'nonsense'))), 'x'.repeat(1024 * 1024 + 1),
    calendar(event(base + '\r\nDESCRIPTION:' + 'é'.repeat(600000))),
  ]) await assert.rejects(preview(content));
});

test('finite expansion excludes past/future and rejects excess total output', async () => {
  const p = await preview(calendar(event(`${base}\r\nRRULE:FREQ=DAILY`)));
  assert.equal(p.items.length, 119);
  assert.ok(p.items.every((i) => i.start >= p.windowStart && i.start < p.windowEnd));
  const many = Array.from({ length: 18 }, (_, i) => event(base.replace('UID:class', `UID:class${i}`) + '\r\nRRULE:FREQ=DAILY'));
  await assert.rejects(preview(calendar(...many)), /2,000/);
});

test('save validation permits unmapped calendar items only, known IDs and bounded valid timestamps', async () => {
  const p = await preview(calendar(event(base)));
  const good = { fileName: p.fileName, items: p.items };
  assert.equal(validateSchedule(good, locations, now).items.length, 1);
  for (const patch of [{ source: 'club' }, { locationId: null }, { locationId: 'unknown' }, { start: '2026-02-30T14:00:00Z' }, { start: '2026-10-23T14:00:00Z' }, { end: p.items[0].start }, { end: '2027-10-24T12:00:00Z' }, { accepted: true }, { id: '' }]) {
    assert.throws(() => validateSchedule({ ...good, items: [{ ...p.items[0], ...patch }] }, locations, now));
  }
  assert.throws(() => validateSchedule({ ...good, items: [p.items[0], p.items[0]] }, locations, now));
  assert.throws(() => validateSchedule({ ...good, owner: 'other' }, locations, now));
});

test('only exact schedule routes accept bodies above 128 KiB; source limits and auth still apply', async () => {
  const app = createApp({ campus: { locations: [] } as unknown as CampusModel, ask: async () => { throw new Error('must not call AI'); }, keyConfigured: false, model: 'test' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const body = JSON.stringify({ fileName: 'classes.ics', content: 'x'.repeat(140000) });
    const send = (path: string, payload = body) => fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: payload });
    assert.equal((await send('/api/dashboard/schedule/preview')).status, 401);
    assert.equal((await send('/api/dashboard/schedule')).status, 401);
    assert.equal((await send('/api/dashboard/schedule/other')).status, 413);
    assert.equal((await send('/api/ask')).status, 413);
    assert.equal((await send('/api/chat')).status, 413);
    assert.equal((await send('/api/dashboard/schedule/preview', JSON.stringify({ content: 'x'.repeat(7 * 1024 * 1024) }))).status, 413);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
