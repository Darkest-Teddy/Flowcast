// The day's conditions: what the behaviour engine (sim/behavior.ts) responds to. A plain record,
// built deterministically from a date, a weekday, BU's academic calendar, the shown weather and an
// optional scenario, so the same inputs always give the same simulated day.
import type { AcademicCalendar } from '../data/academicCalendar';

export type AcademicPeriod =
  | 'classes' // term in session (weekends included: the weekday carries the weekend rhythm)
  | 'holiday' // a single suspended day inside the term (Indigenous Peoples' Day, Patriots' Day)
  | 'break' // a recess or the gap between terms (Thanksgiving, spring recess, winter/summer)
  | 'reading-period' // BU's "Study Period" between the last class and the first exam
  | 'finals'
  | 'move-in' // the days just before a term's first class
  | 'unknown'; // outside the calendar we have

/** Coarse weather families the behaviour modifiers key on (see weatherKind). */
export type WeatherKind = 'dry' | 'rain' | 'storm' | 'snow' | 'heat';
/** °F: cold < 32 ≤ cool < 55 ≤ mild < 72 ≤ warm < 85 ≤ hot. */
export type TemperatureBand = 'cold' | 'cool' | 'mild' | 'warm' | 'hot';

export interface DayWeather {
  kind: WeatherKind;
  /** The map's condition name ("rain", "partly-cloudy"), kept for the explanation. */
  condition: string;
  temperatureF: number | null;
  band: TemperatureBand;
  precipitationMmPerHour: number | null;
  windMph: number | null;
  source: 'live' | 'forecast' | 'simulated' | 'scenario' | 'none';
}

/** A scheduled crowd-puller, e.g. a home hockey game. Times are seconds since midnight. */
export interface DayEvent {
  id: string;
  label: string;
  locationId: string;
  start: number;
  end: number;
  /** Students expected to attend (an estimate; see the scenario's provenance). */
  expectedStudents: number;
  /** Seats at the venue for this event (published), used instead of the everyday activity capacity. */
  capacity: number;
  /** Who is likely to go: residents and/or commuters, by level. */
  audience?: { residents?: boolean; commuters?: boolean; levels?: ('undergraduate' | 'graduate')[] };
  provenance?: { kind: string; note: string; source?: string };
}

export interface DayConditions {
  /** ISO date, Boston calendar day. */
  date: string;
  /** Monday = 0 … Sunday = 6, the simulated timetable day. */
  weekday: number;
  period: AcademicPeriod;
  /** The calendar entry that decided the period ("Study Period", "Thanksgiving Recess"). */
  periodLabel: string;
  weather: DayWeather;
  /** Sunrise and sunset at BU, decimal hours of Boston local time. */
  daylight: { sunrise: number; sunset: number };
  events: DayEvent[];
  scenario?: string;
}

const DAY_MS = 86400000;
const BU = { lat: 42.3505, lon: -71.1054 };

/** Boston observes daylight time from the second Sunday of March to the first Sunday of November. */
export function bostonUtcOffset(date: string): number {
  const [year] = date.split('-').map(Number);
  const nthSunday = (month: number, n: number) => {
    const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
    return iso(Date.UTC(year, month, 1 + ((7 - first) % 7) + (n - 1) * 7));
  };
  return date >= nthSunday(2, 2) && date < nthSunday(10, 1) ? -4 : -5;
}

/** NOAA's approximate sunrise/sunset (zenith 90.833°), within a couple of minutes. */
export function daylightFor(date: string): { sunrise: number; sunset: number } {
  const start = Date.UTC(Number(date.slice(0, 4)), 0, 1);
  const n = Math.round((dayMs(date) - start) / DAY_MS);
  const gamma = 2 * Math.PI / 365 * n;
  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma) - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
  const decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma) - 0.006758 * Math.cos(2 * gamma)
    + 0.000907 * Math.sin(2 * gamma) - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  const lat = BU.lat * Math.PI / 180;
  const cosH = Math.cos(90.833 * Math.PI / 180) / (Math.cos(lat) * Math.cos(decl)) - Math.tan(lat) * Math.tan(decl);
  const hourAngle = Math.acos(Math.max(-1, Math.min(1, cosH))) * 180 / Math.PI;
  const offset = bostonUtcOffset(date) * 60;
  const minutes = (sign: number) => 720 - 4 * (BU.lon + sign * hourAngle) - eqTime + offset;
  return { sunrise: Math.round(minutes(1)) / 60, sunset: Math.round(minutes(-1)) / 60 };
}
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (date: string) => Date.parse(`${date}T12:00:00Z`);
/** Days before the first class that count as move-in (assumption: BU's residence halls open about four days ahead). */
export const MOVE_IN_DAYS = 4;

/** Monday-first weekday of an ISO date. */
export function weekdayOf(date: string): number {
  return (new Date(dayMs(date)).getUTCDay() + 6) % 7;
}

/** The academic period of a date from the Registrar's calendar. */
export function academicPeriodFor(date: string, calendar: AcademicCalendar | undefined): { period: AcademicPeriod; label: string } {
  const terms = [...(calendar?.terms ?? [])].sort((a, b) => a.classesStart.localeCompare(b.classesStart));
  if (!terms.length) return { period: 'unknown', label: 'No academic calendar' };
  for (const term of terms) {
    const examDates = term.events.filter(event => event.kind === 'exams').flatMap(event => [event.start, event.end]).sort();
    const examsStart = examDates[0], examsEnd = examDates.at(-1);
    const moveIn = iso(dayMs(term.classesStart) - MOVE_IN_DAYS * DAY_MS);
    if (date >= moveIn && date < term.classesStart) return { period: 'move-in', label: `Move-in before ${term.term} classes` };
    if (date >= term.classesStart && date <= term.classesEnd) {
      if (term.suspendedDates.includes(date)) {
        const event = term.events.find(row => row.kind === 'suspended' && row.start <= date && date <= row.end);
        const multiDay = event && event.start !== event.end;
        return { period: multiDay ? 'break' : 'holiday', label: event?.label ?? 'Classes suspended' };
      }
      return { period: 'classes', label: `${term.term} classes in session` };
    }
    const study = term.events.find(row => row.kind === 'study' && row.start <= date && date <= row.end);
    if (study) return { period: 'reading-period', label: study.label };
    if (examsStart && examsEnd && date >= examsStart && date <= examsEnd) return { period: 'finals', label: 'Final exams' };
  }
  const first = terms[0], last = terms.at(-1)!;
  const lastExam = last.events.filter(event => event.kind === 'exams').map(event => event.end).sort().at(-1) ?? last.classesEnd;
  if (date < iso(dayMs(first.classesStart) - MOVE_IN_DAYS * DAY_MS) || date > lastExam) return { period: 'unknown', label: 'Outside the imported calendar' };
  return { period: 'break', label: 'Between terms' };
}

/** Map condition → behaviour family. Heat also comes from a hot reading on a dry day. */
export function weatherKind(condition: string, temperatureF: number | null): WeatherKind {
  if (condition === 'snow') return 'snow';
  if (condition === 'thunderstorm') return 'storm';
  if (condition === 'drizzle' || condition === 'rain' || condition === 'heavy-rain') return 'rain';
  if (condition === 'heatwave' || (temperatureF !== null && temperatureF >= 90)) return 'heat';
  return 'dry';
}

export function temperatureBand(temperatureF: number | null): TemperatureBand {
  if (temperatureF === null) return 'mild';
  if (temperatureF < 32) return 'cold';
  if (temperatureF < 55) return 'cool';
  if (temperatureF < 72) return 'mild';
  if (temperatureF < 85) return 'warm';
  return 'hot';
}

export function dayWeather(input: { condition: string; temperatureF?: number | null; precipitationMmPerHour?: number | null; windMph?: number | null;
  source?: DayWeather['source'] } | null | undefined): DayWeather {
  if (!input) return { kind: 'dry', condition: 'unknown', temperatureF: null, band: 'mild', precipitationMmPerHour: null, windMph: null, source: 'none' };
  const temperatureF = input.temperatureF ?? null;
  return { kind: weatherKind(input.condition, temperatureF), condition: input.condition, temperatureF, band: temperatureBand(temperatureF),
    precipitationMmPerHour: input.precipitationMmPerHour ?? null, windMph: input.windMph ?? null, source: input.source ?? 'none' };
}

export interface ConditionsInput {
  date: string;
  /** Defaults to the date's weekday. Playback passes the picker's weekday with the reference-week date. */
  weekday?: number;
  calendar?: AcademicCalendar;
  weather?: Parameters<typeof dayWeather>[0];
  events?: DayEvent[];
  scenario?: string;
  /** A scenario may pin the period (e.g. "finals" on any date). */
  period?: AcademicPeriod;
  periodLabel?: string;
}

/** Deterministic: same input, same record. */
export function conditionsFor(input: ConditionsInput): DayConditions {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error(`Invalid date ${input.date}`);
  const weekday = input.weekday ?? weekdayOf(input.date);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new Error('Weekday must be Monday=0 through Sunday=6');
  const fromCalendar = academicPeriodFor(input.date, input.calendar);
  const period = input.period ?? fromCalendar.period;
  return {
    date: input.date, weekday, period,
    periodLabel: input.period ? input.periodLabel ?? input.period : fromCalendar.label,
    weather: dayWeather(input.weather),
    daylight: daylightFor(input.date),
    events: [...(input.events ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
    ...(input.scenario ? { scenario: input.scenario } : {}),
  };
}

/** Cache key: only what changes behaviour (temperature by band, not by degree). */
export function conditionsKey(conditions: DayConditions): string {
  return [conditions.weekday, conditions.period, conditions.weather.kind, conditions.weather.band,
    conditions.events.map(event => `${event.id}@${event.locationId}:${event.start}-${event.end}x${event.expectedStudents}`).join(','),
    conditions.scenario ?? ''].join('|');
}
