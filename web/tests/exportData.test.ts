import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, exportName, toCsv, toIcs } from '../src/lib/exportData.ts';

test('CSV cells quote commas, quotes and line breaks', () => {
  assert.equal(csvCell('Mugar Library'), 'Mugar Library');
  assert.equal(csvCell('CAS, Room 211'), '"CAS, Room 211"');
  assert.equal(csvCell('The "Light" Festival'), '"The ""Light"" Festival"');
  assert.equal(csvCell('two\nlines'), '"two\nlines"');
  assert.equal(csvCell(0.62), '0.62');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(Number.NaN), '');
});

test('CSV cells never start like a spreadsheet formula', () => {
  assert.equal(csvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
  assert.equal(csvCell('+1 club'), "'+1 club");
  assert.equal(csvCell('-5'), "'-5");
  assert.equal(csvCell('@here'), "'@here");
  assert.equal(csvCell(-5), '-5'); // a real number stays a number
});

test('a CSV has a BOM, a header and CRLF line ends', () => {
  const csv = toCsv(['place', 'share'], [['GSU', 0.5], ['CAS', 0.25]]);
  assert.ok(csv.startsWith('﻿'));
  assert.equal(csv.slice(1), 'place,share\r\nGSU,0.5\r\nCAS,0.25\r\n');
});

test('an .ics file has one escaped, UTC event per entry', () => {
  const ics = toIcs('Flowcast events', [
    { uid: 'e1', title: 'Light Festival; GSU, outdoors', start: '2026-10-25T22:00:00Z', end: '2026-10-26T01:00:00Z', location: 'GSU Backcourts', url: 'https://bu.campuslabs.com/x' },
    { uid: 'e2', title: 'No end', start: '2026-10-26T14:00:00Z' },
    { uid: 'bad', title: 'No start', start: 'not a date' },
  ], new Date('2026-10-25T10:00:00Z'));
  const lines = ics.split('\r\n');
  assert.equal(lines[0], 'BEGIN:VCALENDAR');
  assert.equal(ics.match(/BEGIN:VEVENT/g)?.length, 2);
  assert.ok(lines.includes('SUMMARY:Light Festival\\; GSU\\, outdoors'));
  assert.ok(lines.includes('DTSTART:20261025T220000Z'));
  assert.ok(lines.includes('DTEND:20261026T010000Z'));
  assert.ok(lines.includes('DTEND:20261026T150000Z'), 'an event with no end lasts an hour');
  assert.ok(lines.includes('DTSTAMP:20261025T100000Z'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
});

test('long .ics lines fold at 75 octets', () => {
  const ics = toIcs('x', [{ uid: 'long', title: 'A'.repeat(200), start: '2026-10-25T22:00:00Z' }]);
  for (const line of ics.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, line);
  assert.ok(ics.includes('\r\n A'));
});

test('export names carry the Boston date', () => {
  // 02:00 UTC on 26 Oct is still 25 Oct in Boston.
  assert.equal(exportName('forecasts', 'csv', new Date('2026-10-26T02:00:00Z')), 'flowcast-forecasts-2026-10-25.csv');
});
