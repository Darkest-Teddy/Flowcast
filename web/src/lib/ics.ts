// A small iCalendar (.ics) reader for club and course uploads: enough to preview events before
// publishing, or to expand a recurring class schedule from the BU Student Link into real meetings.
// It reads SUMMARY, DTSTART, DTEND, LOCATION and a weekly RRULE from each VEVENT and reports
// problems with a line number.

export interface IcsRecurrence {
  freq: 'WEEKLY';
  byDay: number[]; // 0 = Sunday .. 6 = Saturday, JS Date.getDay() order
  interval: number; // every N weeks, default 1
  until: string | null; // ISO, inclusive
}

export interface IcsEvent {
  title: string;
  start: string; // ISO
  end: string | null; // ISO, when the event has a DTEND
  allDay: boolean;
  location: string | null;
  recurrence: IcsRecurrence | null;
  line: number; // where BEGIN:VEVENT is
}

export type IcsResult =
  | { ok: true; events: IcsEvent[] }
  | { ok: false; error: string; line: number | null };

interface LogicalLine {
  text: string;
  line: number;
}

/** Joins folded lines (continuations start with a space or tab) and keeps each one's first line number. */
function unfold(text: string): LogicalLine[] {
  const out: LogicalLine[] = [];
  text.split(/\r\n|\n|\r/).forEach((raw, i) => {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && out.length) {
      out[out.length - 1].text += raw.slice(1);
    } else if (raw.trim()) {
      out.push({ text: raw, line: i + 1 });
    }
  });
  return out;
}

/** "DTSTART;TZID=America/New_York:20261030T180000" to name, params and value. */
function splitProperty(text: string) {
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') inQuotes = !inQuotes;
    if (text[i] === ':' && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon === -1) return null;
  const [name, ...params] = text.slice(0, colon).split(';');
  return { name: name.toUpperCase(), params: params.map((p) => p.toUpperCase()), value: text.slice(colon + 1) };
}

function unescapeText(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_, c: string) => (c === 'n' || c === 'N' ? ' ' : c)).trim();
}

/** 20261030, 20261030T180000 or 20261030T180000Z. Floating and TZID times are read as local time. */
function parseDate(value: string): { iso: string; allDay: boolean } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  const parts = [Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0)] as const;
  const date = z ? new Date(Date.UTC(...parts)) : new Date(...parts);
  const month = z ? date.getUTCMonth() : date.getMonth(); // catches rollovers like month 13 or Feb 31
  if (Number.isNaN(date.getTime()) || month !== parts[1]) return null;
  return { iso: date.toISOString(), allDay: h === undefined };
}

const ICS_WEEKDAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/**
 * Enough RRULE to expand a weekly class meeting: FREQ=WEEKLY, BYDAY, INTERVAL and UNTIL.
 * Any other frequency, or a rule with no BYDAY, is treated as non-recurring (returns null) —
 * COUNT-bounded and daily/monthly rules aren't meeting patterns Student Link produces for classes.
 */
function parseRRule(value: string): IcsRecurrence | null {
  const parts = Object.fromEntries(
    value.split(';').map((p) => {
      const [k, v] = p.split('=');
      return [k?.toUpperCase(), v ?? ''];
    }),
  );
  if (parts.FREQ !== 'WEEKLY' || !parts.BYDAY) return null;
  const byDay = parts.BYDAY.split(',')
    .map((d) => ICS_WEEKDAYS[d.trim().toUpperCase()])
    .filter((d): d is number => d !== undefined);
  if (!byDay.length) return null;
  const until = parts.UNTIL ? (parseDate(parts.UNTIL)?.iso ?? null) : null;
  return { freq: 'WEEKLY', byDay, interval: Math.max(1, Number(parts.INTERVAL) || 1), until };
}

export function parseIcs(text: string): IcsResult {
  const lines = unfold(text.replace(/^﻿/, ''));
  if (!lines.length || lines[0].text.trim().toUpperCase() !== 'BEGIN:VCALENDAR') {
    return {
      ok: false,
      line: lines[0]?.line ?? 1,
      error: 'This isn’t an iCalendar file: the first line should be BEGIN:VCALENDAR. Export the calendar as .ics again and upload that file.',
    };
  }

  const events: IcsEvent[] = [];
  let current: {
    line: number;
    title: string;
    start: { iso: string; allDay: boolean } | null;
    end: { iso: string; allDay: boolean } | null;
    location: string | null;
    recurrence: IcsRecurrence | null;
  } | null = null;
  let nested = 0; // depth of components inside an event, like VALARM

  for (const { text: raw, line } of lines) {
    const prop = splitProperty(raw);
    if (!prop) {
      return { ok: false, line, error: `Line ${line}: “${raw.slice(0, 40)}” isn’t a valid calendar line. Each line needs a name, a colon and a value.` };
    }
    const value = prop.value.trim();

    if (prop.name === 'BEGIN') {
      if (value.toUpperCase() === 'VEVENT') {
        if (current) {
          return { ok: false, line: current.line, error: `Line ${current.line}: this event never ends. Add END:VEVENT before the next event starts on line ${line}.` };
        }
        current = { line, title: '', start: null, end: null, location: null, recurrence: null };
      } else if (current) {
        nested++;
      }
      continue;
    }

    if (prop.name === 'END') {
      if (current && nested > 0) {
        nested--;
      } else if (value.toUpperCase() === 'VEVENT' && current) {
        if (!current.start) {
          const name = current.title ? `“${current.title}”` : 'This event';
          return {
            ok: false,
            line: current.line,
            error: `Line ${current.line}: ${name} has no start time (DTSTART). Add a DTSTART line to the event, or remove the event, then upload the file again.`,
          };
        }
        events.push({
          title: current.title || 'Untitled event',
          start: current.start.iso,
          end: current.end?.iso ?? null,
          allDay: current.start.allDay,
          location: current.location,
          recurrence: current.recurrence,
          line: current.line,
        });
        current = null;
      }
      continue;
    }

    if (!current || nested > 0) continue;

    if (prop.name === 'SUMMARY') current.title = unescapeText(value);
    if (prop.name === 'LOCATION') current.location = unescapeText(value) || null;
    if (prop.name === 'DTSTART') {
      const parsed = parseDate(value);
      if (!parsed) {
        return {
          ok: false,
          line,
          error: `Line ${line}: the start time “${value}” isn’t a date Flowcast can read. Use the form 20261030T180000, then upload the file again.`,
        };
      }
      current.start = parsed;
    }
    if (prop.name === 'DTEND') {
      const parsed = parseDate(value);
      if (parsed) current.end = parsed;
    }
    if (prop.name === 'RRULE') current.recurrence = parseRRule(value);
  }

  if (current) {
    return { ok: false, line: current.line, error: `Line ${current.line}: this event never ends. Add END:VEVENT after it, then upload the file again.` };
  }
  if (!events.length) {
    return { ok: false, line: null, error: 'This file has no events in it. Check that you exported the right calendar, then upload it again.' };
  }

  events.sort((a, b) => a.start.localeCompare(b.start));
  return { ok: true, events };
}

export interface IcsOccurrence {
  title: string;
  location: string | null;
  start: string; // ISO
  end: string; // ISO
  sourceLine: number;
}

/**
 * Turns parsed events into concrete dated meetings inside [windowStart, windowEnd), expanding any
 * weekly RRULE and keeping each meeting's original time of day and duration (default 50 minutes
 * when the file has no DTEND). A single-day club event outside the window is dropped; a term-long
 * recurring class is cut down to just the meetings that fall inside it, which keeps an imported
 * semester from flooding a short demo window with months of class sessions.
 */
export function expandOccurrences(events: IcsEvent[], windowStart: Date, windowEnd: Date): IcsOccurrence[] {
  const DEFAULT_DURATION_MS = 50 * 60_000;
  const out: IcsOccurrence[] = [];

  for (const ev of events) {
    const start = new Date(ev.start);
    const durationMs = ev.end ? new Date(ev.end).getTime() - start.getTime() : DEFAULT_DURATION_MS;

    if (!ev.recurrence) {
      if (start >= windowStart && start < windowEnd) {
        out.push({ title: ev.title, location: ev.location, start: ev.start, end: new Date(start.getTime() + durationMs).toISOString(), sourceLine: ev.line });
      }
      continue;
    }

    const { byDay, interval, until } = ev.recurrence;
    const untilDate = until ? new Date(until) : null;
    const rangeEnd = untilDate && untilDate < windowEnd ? untilDate : windowEnd;
    // Walk the window day by day; cheap at demo-window scale (weeks, not years) and avoids
    // reasoning about interval-week alignment across DST changes.
    const day = new Date(Math.max(start.getTime(), windowStart.getTime()));
    day.setHours(0, 0, 0, 0);
    const weeksSinceStart = (d: Date) => Math.floor((d.getTime() - new Date(start).setHours(0, 0, 0, 0)) / (7 * 86_400_000));

    while (day < rangeEnd) {
      if (byDay.includes(day.getDay()) && weeksSinceStart(day) % interval === 0) {
        const occStart = new Date(day);
        occStart.setHours(start.getHours(), start.getMinutes(), start.getSeconds(), 0);
        if (occStart >= windowStart && occStart >= start && occStart < windowEnd) {
          out.push({
            title: ev.title,
            location: ev.location,
            start: occStart.toISOString(),
            end: new Date(occStart.getTime() + durationMs).toISOString(),
            sourceLine: ev.line,
          });
        }
      }
      day.setDate(day.getDate() + 1);
    }
  }

  return out.sort((a, b) => a.start.localeCompare(b.start));
}
