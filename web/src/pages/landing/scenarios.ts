// The landing page's scenario tabs: what a lunch rush, a big event and a fire drill do to the places
// they touch, before and after, from data the page can load. Nothing here is typed in by hand: the
// lunch rush and the event come from the event-impact data (forecast.ts); the fire drill from a file
// the map's own incident model writes (map-client/scripts/build-landing-scenarios.mjs).

import { addDays, clockLabel, hourLabel, placesOfKind, shortDate, weekdayName, type DayForecast, type EventExample } from './forecast';

export interface ScenarioRow {
  id: string;
  name: string;
  /** Share of capacity before and after; null when the data has no reading. */
  before: number | null;
  after: number | null;
  /** When the after reading is, when it differs per row ("12 PM"). */
  at?: string;
}

export interface ScenarioResult {
  /** "Tuesday · 10 AM vs lunch". */
  when: string;
  /** Short label under the tab ("4 dining halls"). */
  tag: string;
  beforeLabel: string;
  afterLabel: string;
  rows: ScenarioRow[];
  /** A line under the rows, for what the rows can't show (where a drill's evacuees went). */
  note?: string;
}

const LUNCH_BEFORE = 10;
const LUNCH_HOURS = [11, 12, 13, 14];

/** The biggest dining halls at 10 AM against each one's busiest lunch hour, busiest first. */
export function lunchRush(day: DayForecast | null): ScenarioResult | null {
  if (!day) return null;
  const rows = placesOfKind(day, 'dining', 4)
    .map((place): ScenarioRow | null => {
      let peak: number | null = null;
      for (const hour of LUNCH_HOURS) {
        const share = day.share(place.id, hour);
        if (share != null && (peak == null || share > day.share(place.id, peak)!)) peak = hour;
      }
      if (peak == null) return null;
      return { id: place.id, name: place.short, before: day.share(place.id, LUNCH_BEFORE), after: day.share(place.id, peak), at: hourLabel(peak) };
    })
    .filter((row) => row != null)
    .sort((a, b) => (b.after ?? 0) - (a.after ?? 0))
    .slice(0, 3);
  if (!rows.length) return null;
  return {
    when: `${weekdayName(day.date)} · ${hourLabel(LUNCH_BEFORE)} vs lunch`,
    tag: `${rows.length} dining halls`,
    beforeLabel: hourLabel(LUNCH_BEFORE),
    afterLabel: 'Lunch peak',
    rows,
  };
}

/** The week's best-attended event at its venue, without and with it (eventExample). */
export function gameNight(event: EventExample | null): ScenarioResult | null {
  if (!event) return null;
  return {
    when: `${shortDate(event.date)} · ${event.name} at ${clockLabel(event.startSec)}`,
    tag: event.venue.short,
    beforeLabel: 'Without the event',
    afterLabel: 'With it',
    rows: [{ id: event.venue.id, name: event.venue.short, before: event.before, after: event.after, at: hourLabel(event.hour) }],
  };
}

/** map-client/public/data/landing-scenarios.json, as far as the page reads it. */
export interface LandingScenariosFile {
  fireDrill?: {
    date?: string;
    weekday?: number;
    alarmAt: string;
    measuredAt: string;
    reopensAt?: string;
    building: { id: string; name: string; short?: string };
    places: { id: string; name: string; short?: string; before: number; after: number; sameBuilding?: boolean }[];
    assembly?: { count: number };
    outcomes?: Record<string, number>;
  };
}

export async function loadLandingScenarios(): Promise<LandingScenariosFile | null> {
  const response = await fetch('/data/landing-scenarios.json');
  if (!response.ok) return null;
  return response.json();
}

/** "11:00" → "11 AM", "11:10" → "11:10 AM". */
const clock = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return clockLabel(h * 3600 + m * 60);
};

/**
 * The fire drill the map's incident model ran: the drilled building emptying. In the model the
 * evacuees wait at an outdoor assembly point rather than going into other buildings (those barely
 * move), so the card shows the building and says where its people are instead.
 */
export function fireDrill(file: LandingScenariosFile | null, referenceWeekStart?: string): ScenarioResult | null {
  const drill = file?.fireDrill;
  if (!drill?.places?.length) return null;
  const date = drill.date ?? (referenceWeekStart != null && drill.weekday != null ? addDays(referenceWeekStart, drill.weekday) : null);
  const building = drill.building.short ?? drill.building.name;
  return {
    when: `${date ? `${weekdayName(date)} · ` : ''}alarm at ${clock(drill.alarmAt)}`,
    tag: building,
    beforeLabel: 'Before the alarm',
    afterLabel: clock(drill.measuredAt),
    rows: drill.places
      .filter((p) => p.sameBuilding ?? p.id === drill.building.id)
      .map((p) => ({ id: p.id, name: p.short ?? p.name, before: p.before, after: p.after })),
    note: drill.assembly
      ? `${drill.assembly.count.toLocaleString('en-US')} people wait at the outdoor assembly point${drill.reopensAt ? `; ${(drill.outcomes?.['occupant-resume'] ?? 0).toLocaleString('en-US')} go back in when it reopens at ${clock(drill.reopensAt)}` : ''}.`
      : undefined,
  };
}
