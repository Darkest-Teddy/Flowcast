// A small iCalendar (.ics) reader for club uploads: enough to preview events before publishing.
// It reads SUMMARY, DTSTART and LOCATION from each VEVENT and reports problems with a line number.

export interface IcsEvent {
  title: string;
  start: string; // ISO
  allDay: boolean;
  location: string | null;
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
  let current: { line: number; title: string; start: { iso: string; allDay: boolean } | null; location: string | null } | null = null;
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
        current = { line, title: '', start: null, location: null };
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
        events.push({ title: current.title || 'Untitled event', start: current.start.iso, allDay: current.start.allDay, location: current.location, line: current.line });
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
