// Every date, time and number shown on screen goes through here, so the format stays consistent.

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const weekdayLong = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const dayTime = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export const formatTime = (isoString: string) => time.format(new Date(isoString));
export const formatWeekday = (isoString: string, long = false) => (long ? weekdayLong : weekday).format(new Date(isoString));
export const formatDayTime = (isoString: string) => dayTime.format(new Date(isoString));
export const formatPercent = (share: number) => `${Math.round(share * 100)}%`;

export function formatHour(hour: number): string {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(d);
}

/** "4 minutes ago", "yesterday", "in 2 hours". */
export function formatRelative(isoString: string, now = Date.now()): string {
  const diffSec = (new Date(isoString).getTime() - now) / 1000;
  const abs = Math.abs(diffSec);
  if (abs < 45) return 'just now';
  if (abs < 3600) return relative.format(Math.round(diffSec / 60), 'minute');
  if (abs < 86400) return relative.format(Math.round(diffSec / 3600), 'hour');
  return relative.format(Math.round(diffSec / 86400), 'day');
}

export function isToday(isoString: string, now = new Date()): boolean {
  const d = new Date(isoString);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

const longDay = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

/** Local calendar day of a timestamp, for grouping: "2026-10-24". */
export function dayKey(isoString: string): string {
  const d = new Date(isoString);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "Today", "Tomorrow", or "Monday, Oct 26". */
export function formatDayLabel(isoString: string, now = new Date()): string {
  if (isToday(isoString, now)) return 'Today';
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (isToday(isoString, tomorrow)) return 'Tomorrow';
  return longDay.format(new Date(isoString));
}

const dateOnly = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const dateTime = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** "Oct 12, 2026". */
export const formatDate = (isoString: string) => dateOnly.format(new Date(isoString));

/** "180 m", "1.2 km". Rounded to 10 m: the routes aren't more precise than that. */
export function formatMeters(meters: number): string {
  return meters < 1000 ? `${Math.max(10, Math.round(meters / 10) * 10)} m` : `${(meters / 1000).toFixed(1)} km`;
}
/** "Fri, Oct 30, 6:00 PM": for times that may be weeks away. */
export const formatDateTime = (isoString: string) => dateTime.format(new Date(isoString));

/** "12:15" (24-hour, as stored) to "12:15 PM" in the reader's locale. */
export function formatClock(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return time.format(d);
}
