// Getting data off the site: CSV for spreadsheets, iCalendar (.ics) for calendar apps, and the
// download itself. No imports, so node --test runs it as is.

export type Cell = string | number | boolean | null | undefined;

/**
 * One CSV cell. Quoted when it holds a comma, quote or line break. Text that a spreadsheet would
 * read as a formula (=, +, -, @, tab, carriage return at the start) gets a leading apostrophe:
 * event titles and venues come from public listings, and an opened CSV must never run anything.
 */
export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A header row and data rows to CSV, CRLF line ends (RFC 4180), with a BOM so Excel reads UTF-8. */
export function toCsv(header: string[], rows: Cell[][]): string {
  return '\uFEFF' + [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export interface CalendarEvent {
  uid: string;
  title: string;
  start: string; // ISO
  end?: string | null; // ISO; one hour after start when missing
  location?: string | null;
  description?: string | null;
  url?: string | null;
}

function icsText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** 2026-10-30T22:00:00.000Z to 20261030T220000Z. */
function icsTime(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Lines longer than 75 octets fold onto continuation lines that start with a space (RFC 5545 §3.1). */
function fold(line: string): string {
  const bytes = new TextEncoder();
  if (bytes.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = '';
  for (const ch of line) {
    const limit = parts.length ? 74 : 75; // continuation lines spend one octet on the leading space
    if (bytes.encode(current + ch).length > limit) {
      parts.push(current);
      current = ch;
    } else current += ch;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

/** Events to an iCalendar file that Google Calendar, Apple Calendar and Outlook import. Times are UTC. */
export function toIcs(name: string, events: CalendarEvent[], stamp = new Date()): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Flowcast//Export//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsText(name)}`];
  for (const e of events) {
    if (!Number.isFinite(Date.parse(e.start))) continue;
    const end = e.end && Date.parse(e.end) > Date.parse(e.start) ? e.end : new Date(Date.parse(e.start) + 3_600_000).toISOString();
    lines.push(
      'BEGIN:VEVENT',
      `UID:${icsText(e.uid)}@flowcast`,
      `DTSTAMP:${icsTime(stamp.toISOString())}`,
      `DTSTART:${icsTime(e.start)}`,
      `DTEND:${icsTime(end)}`,
      `SUMMARY:${icsText(e.title)}`,
      ...(e.location ? [`LOCATION:${icsText(e.location)}`] : []),
      ...(e.description ? [`DESCRIPTION:${icsText(e.description)}`] : []),
      ...(e.url && /^https?:\/\//.test(e.url) ? [`URL:${e.url}`] : []),
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** "flowcast-forecasts-2026-10-25.csv": the date is today's in Boston, like everything else on the site. */
export function exportName(what: string, extension: 'csv' | 'ics', at = new Date()): string {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(at);
  return `flowcast-${what}-${day}.${extension}`;
}

/** Hands the text to the browser as a file download. */
export function download(fileName: string, content: string, type: 'text/csv' | 'text/calendar' | 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
