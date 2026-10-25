// "Best time this week" for one place: its quietest and busiest open hours across several days,
// from the event-impact build's hourly modeled head counts (the weekday baseline, or the dated
// figures when simulated campus events change that place on that date).
//
// Only whole hours the place is open by its published hours are ranked: closed is not quiet, and
// unknown hours are not open. Hours with no modeled students are left out (no model coverage is not
// evidence of quiet), as forecastsFromBundle does for the dashboard. Every figure is model-derived,
// never a measurement.
//
// Self-contained (type imports only) so the server's Ask tool, the dashboard route and the web's
// node tests all load it as is.

/** The parts of event-impact.json this reads. */
export interface HourlyImpact {
  /** Weekday (Monday = 0) → place id → 24 hourly mean simulated head counts, without events. */
  baseline: Record<string, Record<string, number[]>>;
  /** Date → the places simulated campus events changed that day, with their 24 hourly counts. */
  dates: Record<string, { occupancy: Record<string, number[]> }>;
}

export interface WeekDay {
  /** YYYY-MM-DD. */
  date: string;
  /** 0 = Monday … 6 = Sunday. */
  weekday: number;
}

/**
 * Published opening state at a second of the day: true open, false closed, null unknown. Return
 * null (not true) for the after-midnight part of the previous day's hours, which isn't modeled.
 */
export type OpenCheck = (day: WeekDay, seconds: number) => boolean | null;

export interface HourFigure extends WeekDay {
  hour: number;
  /** Hourly mean modeled head count, rounded. */
  students: number;
  /** Head count over stated capacity, or null when the capacity isn't comparable. */
  share: number | null;
  /** The dated figure, with simulated campus events, rather than the weekday baseline. */
  withEvents: boolean;
}

export interface DayExtremes extends WeekDay {
  openHours: number;
  quietest: HourFigure | null;
  busiest: HourFigure | null;
}

export interface BestTimes {
  /** What the ranking is by: share of stated capacity, or modeled students when it isn't comparable. */
  measure: 'share' | 'students';
  /** Ranked (open, modeled) hours in date and hour order. */
  hours: HourFigure[];
  /** The quietest hours, at most one per day, quietest first. */
  quietest: HourFigure[];
  /** The busiest hours, at most one per day, busiest first. */
  busiest: HourFigure[];
  /** Each day's extremes, in the order the days were given. */
  byDay: DayExtremes[];
  /** Days with no published hours for the date (unknown, not closed): nothing is ranked on them. */
  daysWithoutHours: WeekDay[];
  /** Days the place is closed for the whole window by its published hours. */
  daysClosed: WeekDay[];
}

export interface BestTimesInput {
  impact: HourlyImpact;
  placeId: string;
  /** Stated capacity when a percentage is comparable for this place, else null (rank by students). */
  capacity: number | null;
  days: WeekDay[];
  open: OpenCheck;
  /** Window of hours to rank, [fromHour, toHour), whole hours; default the whole day. */
  fromHour?: number;
  toHour?: number;
  /** How many quietest and busiest hours to return (default 3). */
  top?: number;
}

/** Sampled every 15 minutes: a whole hour counts as open only when it is open throughout. */
const SAMPLES = [0, 900, 1800, 2700, 3599];

/** The 24 hourly modeled counts for a place on a day, and whether they include simulated events. */
export function hourlyCounts(impact: HourlyImpact, placeId: string, day: WeekDay): { counts: number[] | null; withEvents: boolean } {
  const dated = impact.dates[day.date]?.occupancy[placeId];
  if (dated) return { counts: dated, withEvents: true };
  return { counts: impact.baseline[String(day.weekday)]?.[placeId] ?? null, withEvents: false };
}

export function bestTimesForPlace(input: BestTimesInput): BestTimes {
  const { impact, placeId, capacity, days, open } = input;
  const from = Math.max(0, Math.min(24, Math.floor(input.fromHour ?? 0)));
  const to = Math.max(from, Math.min(24, Math.ceil(input.toHour ?? 24)));
  const top = Math.max(1, input.top ?? 3);
  const measure: BestTimes['measure'] = capacity !== null && capacity > 0 ? 'share' : 'students';
  const value = (h: HourFigure) => (measure === 'share' ? h.share ?? 0 : h.students);

  const hours: HourFigure[] = [];
  const byDay: DayExtremes[] = [];
  const daysWithoutHours: WeekDay[] = [];
  const daysClosed: WeekDay[] = [];
  for (const day of days) {
    const { counts, withEvents } = hourlyCounts(impact, placeId, day);
    const states: (boolean | null)[] = [];
    const ranked: HourFigure[] = [];
    for (let hour = from; hour < to; hour++) {
      const samples = SAMPLES.map((s) => open(day, hour * 3600 + s));
      states.push(...samples);
      if (!samples.every((s) => s === true)) continue;
      const count = counts?.[hour];
      if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) continue;
      ranked.push({ ...day, hour, students: Math.round(count), share: measure === 'share' ? count / capacity! : null, withEvents });
    }
    if (states.length && states.every((s) => s === null)) daysWithoutHours.push(day);
    else if (states.length && states.every((s) => s !== true)) daysClosed.push(day);
    hours.push(...ranked);
    const pick = (better: (a: number, b: number) => boolean) => ranked.reduce<HourFigure | null>((best, h) => (!best || better(value(h), value(best)) ? h : best), null);
    byDay.push({ ...day, openHours: ranked.length, quietest: pick((a, b) => a < b), busiest: pick((a, b) => a > b) });
  }
  const extremes = (key: 'quietest' | 'busiest', sign: 1 | -1) => byDay
    .map((d) => d[key]).filter((h): h is HourFigure => h !== null)
    .sort((a, b) => sign * (value(a) - value(b)) || a.date.localeCompare(b.date) || a.hour - b.hour)
    .slice(0, top);
  return { measure, hours, quietest: extremes('quietest', 1), busiest: extremes('busiest', -1), byDay, daysWithoutHours, daysClosed };
}

/** One place's best times across the days, for the dashboard's "Best times this week". */
export interface PlaceWeek {
  locationId: string;
  measure: BestTimes['measure'];
  quietest: HourFigure[];
  busiest: HourFigure[];
  byDay: DayExtremes[];
  /** Dates with no published hours (unknown, not closed). */
  daysWithoutHours: string[];
  basis: string;
}

/**
 * Best times for every place whose hours are published, over `days`. A place with no ranked hour
 * on any day is left out rather than shown as quiet.
 */
export function weekBestTimes(impact: HourlyImpact & { referenceWeekStart: string }, places: { id: string; capacity: number }[], days: WeekDay[],
  open: (placeId: string, day: WeekDay, seconds: number) => boolean | null): PlaceWeek[] {
  if (!days.length) return [];
  const basis = `Model-derived from the event-impact build (reference week ${impact.referenceWeekStart}, with simulated campus events where it has them) for ${days[0].date} to ${days[days.length - 1].date}. Only whole hours open by published hours are ranked; hours with no simulated students are left out. Not live occupancy.`;
  return places.flatMap((p) => {
    const r = bestTimesForPlace({ impact, placeId: p.id, capacity: p.capacity > 0 ? p.capacity : null, days, open: (day, s) => open(p.id, day, s) });
    if (!r.hours.length) return [];
    return [{ locationId: p.id, measure: r.measure, quietest: r.quietest, busiest: r.busiest, byDay: r.byDay, daysWithoutHours: r.daysWithoutHours.map((d) => d.date), basis }];
  });
}

/** The `count` calendar days from `start` (YYYY-MM-DD), with their weekdays (Monday = 0). */
export function weekFrom(start: string, count = 7): WeekDay[] {
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(`${start}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return { date: d.toISOString().slice(0, 10), weekday: (d.getUTCDay() + 6) % 7 };
  });
}
