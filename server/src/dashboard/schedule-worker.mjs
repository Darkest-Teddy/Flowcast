import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ical from 'node-ical';

class CalendarValidationError extends Error {}
function fail(message) { throw new CalendarValidationError(message); }
// Use the pinned parser's exact Windows mappings, never fuzzy guesses or fixed offsets.
const windowsZones = JSON.parse(readFileSync(new URL('./windowsZones.json', import.meta.resolve('node-ical')), 'utf8'));
const text = (value) => typeof value === 'string' ? value : typeof value?.val === 'string' ? value.val : '';
const normalize = (value) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function validateRule(value) {
  if (value.length > 1024) fail('Recurrence rule is too long.');
  const parts = new Map();
  const ranges = { BYMONTH: [1, 12], BYMONTHDAY: [-31, 31], BYYEARDAY: [-366, 366], BYWEEKNO: [-53, 53], BYSETPOS: [-366, 366] };
  for (const segment of value.split(';')) {
    const pair = /^([A-Z]+)=(.+)$/.exec(segment);
    if (!pair || parts.has(pair[1])) fail('Invalid or duplicate recurrence rule field.');
    const [, key, val] = pair; parts.set(key, val);
    if (key === 'FREQ') {
      if (!/^(DAILY|WEEKLY|MONTHLY|YEARLY)$/.test(val)) fail('Only daily, weekly, monthly and yearly recurrence rules are supported.');
    } else if (key === 'COUNT' || key === 'INTERVAL') {
      if (!/^[1-9]\d{0,6}$/.test(val) || Number(val) > (key === 'COUNT' ? 1000000 : 10000)) fail('Recurrence count and interval must be positive bounded integers.');
    } else if (key === 'UNTIL') {
      if (!/^\d{8}(?:T\d{6}Z?)?$/.test(val)) fail('Invalid recurrence end timestamp.');
      const stamp = `${val.slice(0, 4)}-${val.slice(4, 6)}-${val.slice(6, 8)}T${val.length > 8 ? `${val.slice(9, 11)}:${val.slice(11, 13)}:${val.slice(13, 15)}` : '00:00:00'}Z`;
      const date = new Date(stamp);
      if (!Number.isFinite(+date) || date.toISOString().slice(0, 19) !== stamp.slice(0, 19) || date.getUTCFullYear() < 1900 || date.getUTCFullYear() > 2200) fail('Invalid recurrence end timestamp.');
    } else if (key === 'WKST') {
      if (!/^(MO|TU|WE|TH|FR|SA|SU)$/.test(val)) fail('Invalid recurrence week start.');
    } else if (key === 'BYDAY') {
      if (val.split(',').some((day) => !/^(?:[+-]?[1-9]\d?)?(MO|TU|WE|TH|FR|SA|SU)$/.test(day) || Math.abs(parseInt(day) || 0) > 53)) fail('Invalid recurrence weekday.');
    } else if (Object.hasOwn(ranges, key)) {
      const [min, max] = ranges[key];
      if (val.split(',').some((n) => !/^[+-]?\d{1,3}$/.test(n) || Number(n) === 0 || Number(n) < min || Number(n) > max)) fail('Invalid recurrence date selector.');
    } else fail('Unsupported recurrence rule field. Sub-day expansion is not supported.');
  }
  if (!parts.has('FREQ') || (parts.has('COUNT') && parts.has('UNTIL'))) fail('Recurrence requires FREQ and cannot combine COUNT with UNTIL.');
}
function matchLocation(value, locations) {
  const full = normalize(value);
  const building = full.replace(/\s+(?:(?:room|rm|suite)\s+)?(?:[a-z]?\d+[a-z]?|aud)$/i, '');
  const aliases = (l) => [l.name, l.short, ...(l.buildingCodes ?? [])].map(normalize).filter(Boolean);
  const exact = locations.filter((l) => aliases(l).includes(full));
  if (exact.length) return exact.length === 1 ? exact[0].id : '';
  const matches = locations.filter((l) => aliases(l).includes(building));
  if (matches.length) return matches.length === 1 ? matches[0].id : '';
  // An address prefix may precede a complete building code and room, never a partial code.
  if (building === full || !/^\d+[\s-]/.test(value.trim())) return '';
  const suffix = locations.filter((l) => [l.short, ...(l.buildingCodes ?? [])].some((s) => {
    const code = normalize(s);
    return /^[a-z]{2,8}$/.test(code) && building.endsWith(` ${code}`);
  }));
  return suffix.length === 1 ? suffix[0].id : '';
}

function embeddedEasternZone(lines) {
  const blocks = lines.join('\n').match(/BEGIN:VTIMEZONE\n[\s\S]*?\nEND:VTIMEZONE/g) ?? [];
  const edt = blocks.filter((block) => block.split('\n').includes('TZID:EDT'));
  if (edt.length !== 1) return false;
  const expected = ['BEGIN:VTIMEZONE', 'TZID:EDT',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT',
    'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST',
    'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD', 'END:VTIMEZONE'];
  return edt[0] === expected.join('\n');
}

function prepare(content, warnings) {
  const lines = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').trim().split('\n');
  if (lines[0] !== 'BEGIN:VCALENDAR' || lines.at(-1) !== 'END:VCALENDAR' || content.includes('\0')) fail('Expected a complete iCalendar VCALENDAR file.');
  const eastern = embeddedEasternZone(lines);
  let eventStart = 0; let malformed = false; let skippedDates = 0;
  const stack = []; const identities = new Set(); let fields; let count = 0; let floating = false;
  const result = [];
  for (let line of lines) {
    if (!line.trim()) continue;
    if (line.length > 16384) fail('Calendar property is too long.');
    const match = /^([A-Z0-9-]+)((?:;[^:"]*(?:"[^"]*"[^:"]*)*)?):(.*)$/i.exec(line);
    if (!match) fail('Malformed calendar property.');
    const [, rawName, params, value] = match; const name = rawName.toUpperCase();
    if (name === 'BEGIN') {
      if (stack.length >= 8 || (value === 'VCALENDAR' && stack.length)) fail('Invalid calendar nesting.');
      if (value === 'VEVENT') {
        if (stack.at(-1) !== 'VCALENDAR' || ++count > 2000) fail('Calendar must contain at most 2,000 events.');
        fields = new Map(); eventStart = result.length; malformed = false;
      }
      stack.push(value);
    } else if (name === 'END') {
      if (stack.pop() !== value) fail('Mismatched calendar components.');
      if (value === 'VEVENT') {
        const uid = fields.get('UID'); const rid = fields.get('RECURRENCE-ID') ?? '';
        if (!uid || uid.length > 1000 || (!fields.has('DTSTART') && !(rid && fields.get('STATUS') === 'CANCELLED'))) fail('Each event needs a UID and start time.');
        const identity = JSON.stringify([uid, rid]);
        if (identities.has(identity)) fail('Duplicate calendar UID or recurrence exception.');
        identities.add(identity);
        if (fields.has('DTEND') && fields.has('DURATION')) fail('An event cannot specify both DTEND and DURATION.');
        if (malformed) {
          skippedDates++;
          result.splice(eventStart);
          // Keep cancelled overrides so a malformed replacement cannot resurrect its original.
          if (rid) result.push('BEGIN:VEVENT', `UID:${uid}`, fields.get('RID-LINE'), 'STATUS:CANCELLED');
          else { fields = undefined; continue; }
        }
        fields = undefined;
      }
    } else if (!stack.length) fail('Property outside the calendar.');
    if (stack.at(-1) === 'VEVENT') {
      if (['UID', 'DTSTART', 'DTEND', 'DURATION', 'RRULE', 'RECURRENCE-ID', 'STATUS'].includes(name)) {
        if (fields.has(name)) fail('Duplicate event property.');
        fields.set(name, value);
      }
      if (name === 'RDATE' || name === 'EXRULE' || /;RANGE=/i.test(params)) fail('RDATE, EXRULE and ranged recurrence exceptions are not supported.');
      if (name === 'RRULE') {
        validateRule(value);
      }
      if (name === 'DURATION' && !/^\+?P(?:\d{1,3}W|(?:\d{1,3}D)?(?:T(?=\d)(?:\d{1,3}H)?(?:\d{1,3}M)?(?:\d{1,3}S)?)?)$/.test(value)) fail('Invalid event duration.');
    }
    const tz = /;TZID=(?:"([^"]+)"|([^;]+))/i.exec(params);
    if (tz) {
      const zone = tz[1] ?? tz[2];
      const mapped = zone === 'EDT' && eastern ? 'America/New_York' : Object.hasOwn(windowsZones, zone) ? windowsZones[zone].iana[0] : zone;
      if (zone === 'EDT' && eastern) {
        if (value.split(',').some((date) => Number(date.slice(0, 4)) < 2007)) fail('Embedded Eastern timezone is supported only for dates from 2007 onward.');
        line = line.replace(/;TZID=(?:"EDT"|EDT)(?=;|:)/i, ';TZID=America/New_York');
      }
      try { new Intl.DateTimeFormat('en', { timeZone: mapped }).format(); }
      catch { fail('Unrecognized calendar timezone. Export with an IANA timezone such as America/New_York.'); }
    }
    if (stack.at(-1) === 'VEVENT' && ['DTSTART', 'DTEND', 'EXDATE', 'RECURRENCE-ID'].includes(name)) {
      const dates = value.split(',');
      if (['DTSTART', 'DTEND'].includes(name) && /;VALUE=DATE-TIME(?:;|$)/i.test(params) && dates.some((d) => /^\d{8}$/.test(d))) malformed = true;
      for (const date of dates) {
        if (!/^\d{8}(?:T\d{6}Z?)?$/.test(date)) fail('Invalid calendar date or time.');
        const y = Number(date.slice(0, 4)); const m = Number(date.slice(4, 6)); const d = Number(date.slice(6, 8));
        const check = new Date(Date.UTC(y, m - 1, d));
        if (y < 1900 || y > 2200 || check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d || (date.length > 8 && (Number(date.slice(9, 11)) > 23 || Number(date.slice(11, 13)) > 59 || Number(date.slice(13, 15)) > 59))) fail('Invalid or out-of-range calendar timestamp.');
      }
      if (!tz && dates.every((d) => d.length === 15)) {
        line = `${name}${params};TZID=America/New_York:${value}`; floating = true;
      }
    }
    if (stack.at(-1) === 'VEVENT' && name === 'RECURRENCE-ID') fields.set('RID-LINE', line);
    result.push(line);
  }
  if (stack.length || !count) fail('The calendar has no complete events.');
  if (skippedDates) warnings.add(`${skippedDates} event(s) skipped: VALUE=DATE-TIME contains a date without a time. Export these entries with explicit start and end times.`);
  if (floating) warnings.add('Times without a timezone are interpreted in America/New_York (Boston).');
  return result.join('\r\n');
}

function parse() {
  const { content, locations, windowStart, windowEnd, maxItems } = workerData;
  const warnings = new Set(); const prepared = prepare(content, warnings);
  const data = ical.sync.parseICS(prepared); const items = [];
  let skippedDurations = 0;
  const from = new Date(windowStart); const to = new Date(Date.parse(windowEnd) - 1);
  for (const event of Object.values(data)) {
    if (event.type !== 'VEVENT' || event.status === 'CANCELLED') continue;
    if (event.datetype === 'date' || event.start?.dateOnly) { warnings.add('All-day events were skipped; only events with start and end times are supported.'); continue; }
    if (!(event.start instanceof Date) || !Number.isFinite(+event.start)) fail('An event has an invalid start time.');
    if (!(event.end instanceof Date) || !Number.isFinite(+event.end) || +event.end <= +event.start) { skippedDurations++; continue; }
    for (const instance of ical.expandRecurringEvent(event, { from, to })) {
      if (instance.event.status === 'CANCELLED') continue;
      if (instance.event.start?.dateOnly) { warnings.add('All-day events were skipped; only events with start and end times are supported.'); continue; }
      if (!(instance.end instanceof Date) || !Number.isFinite(+instance.end) || +instance.end <= +instance.start) { skippedDurations++; continue; }
      const locationText = text(instance.event.location ?? event.location);
      const title = text(instance.summary).trim() || 'Untitled event';
      if (title.length > 300 || locationText.length > 1000) fail('Event titles must be at most 300 characters and locations at most 1,000.');
      const locationId = matchLocation(locationText, locations);
      if (!locationId) warnings.add('Some locations could not be matched uniquely. Select their campus buildings before saving, or leave them unmapped.');
      const identity = instance.event.recurrenceid ?? instance.start;
      const id = 'calendar:' + createHash('sha256').update(`${event.uid}\0${identity.toISOString()}`).digest('hex');
      items.push({ id, title, locationId, locationText, start: instance.start.toISOString(), end: instance.end.toISOString(), source: 'calendar' });
      if (items.length > maxItems) fail('Calendar expands to more than 2,000 items. Import a smaller calendar.');
    }
  }
  if (skippedDurations) warnings.add(`${skippedDurations} event(s) skipped: missing or non-positive duration (including zero-duration exams). Confirm start/end times and the assigned exam venue before importing; no duration or venue was inferred.`);
  if (!items.length) warnings.add('No supported timed events fall within the next 120 Boston days.');
  items.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
  return { items, warnings: [...warnings] };
}
try { parentPort.postMessage(parse()); }
catch (error) {
  // Only our validation messages are exposed; library errors may include calendar contents.
  parentPort.postMessage({ error: error instanceof CalendarValidationError ? error.message : 'Invalid calendar or recurrence rule.' });
}
