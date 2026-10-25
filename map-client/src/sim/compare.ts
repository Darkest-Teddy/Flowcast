// Paired comparison of two simulated days of the same roster (same students, same random seeds):
// walkers by hour and the places whose attendance changes most. Computed in the day worker.
import type { DayData } from './playback';
import type { SourceDay } from './sourceDay';

export interface PlaceChange { id: string; name: string; baseline: number; scenario: number; delta: number }
export interface DayComparison {
  /** Average people walking during each hour. */
  hours: { hour: number; baseline: number; scenario: number }[];
  /** Person-hours spent at buildings and outdoor spots (07:00–24:00): the five biggest gains and losses. */
  busier: PlaceChange[];
  quieter: PlaceChange[];
  totals: { id: string; label: string; baseline: number; scenario: number }[];
}

const OPEN_FROM = 7 * 3600;

function walkersByHour(day: DayData): number[] {
  const delta = new Float64Array(1441);
  for (const trip of day.trips) {
    const start = Math.max(0, Math.floor(trip.timestamps[0] / 60)), end = Math.min(1440, Math.ceil(trip.timestamps.at(-1)! / 60));
    if (end > start) { delta[start]++; delta[end]--; }
  }
  const hours = new Array(24).fill(0);
  let running = 0;
  for (let minute = 0; minute < 1440; minute++) { running += delta[minute]; hours[Math.floor(minute / 60)] += running / 60; }
  return hours;
}

function personHours(day: DayData, placeOf: (location: string) => string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const stay of day.stays ?? []) {
    const place = placeOf(stay.location);
    if (!place) continue;
    const seconds = Math.max(0, stay.end - Math.max(stay.start, OPEN_FROM));
    if (seconds > 0) out.set(place, (out.get(place) ?? 0) + seconds / 3600);
  }
  return out;
}

export function compareDays(baseline: SourceDay, scenario: SourceDay, base: DayData, outdoorNames: Record<string, string> = {}): DayComparison {
  const building = new Map<string, { id: string; name: string }>();
  for (const location of base.locations) {
    if (location.kind === 'off-campus' || location.kind === 'dorm') continue;
    const current = building.get(location.id);
    if (!current) building.set(location.id, { id: location.building, name: location.name });
  }
  const names = new Map<string, string>();
  const placeOf = (id: string) => {
    if (outdoorNames[id]) { names.set(id, outdoorNames[id]); return id; }
    const row = building.get(id);
    if (!row) return undefined;
    if (!names.has(row.id)) names.set(row.id, row.name);
    return row.id;
  };
  const before = personHours(baseline, placeOf), after = personHours(scenario, placeOf);
  const ids = new Set([...before.keys(), ...after.keys()]);
  const places = [...ids].map(id => ({ id, name: names.get(id) ?? id, baseline: before.get(id) ?? 0, scenario: after.get(id) ?? 0, delta: (after.get(id) ?? 0) - (before.get(id) ?? 0) }))
    .filter(row => Math.abs(row.delta) >= 1);
  const busier = places.filter(row => row.delta > 0).sort((x, y) => y.delta - x.delta || x.name.localeCompare(y.name)).slice(0, 5);
  const quieter = places.filter(row => row.delta < 0).sort((x, y) => x.delta - y.delta || x.name.localeCompare(y.name)).slice(0, 5);
  const a = walkersByHour(baseline), b = walkersByHour(scenario);
  const count = (day: SourceDay, test: (kind: string, location: string) => boolean) => day.sourceActivities.filter(row => test(row.kind, row.locationId)).length;
  const kinds: [string, string, (kind: string, location: string) => boolean][] = [
    ['classes', 'Class attendances', () => false],
    ['library', 'Library visits', kind => kind === 'library'],
    ['dining', 'Dining hall meals', kind => kind === 'dining'],
    ['gym', 'Gym visits', kind => kind === 'gym'],
    ['outdoor', 'Visits to BU Beach, the Esplanade and the river path', kind => kind === 'outdoor'],
    ['outings', 'Outings and meals off campus', kind => kind === 'off-campus-outing' || kind === 'off-campus-meal'],
    ['events', 'Event attendance (campus and scenario events)', kind => kind === 'gathering'],
  ];
  const totals = kinds.map(([id, label, test]) => id === 'classes'
    ? { id, label, baseline: baseline.sourceAssignments.length, scenario: scenario.sourceAssignments.length }
    : { id, label, baseline: count(baseline, test), scenario: count(scenario, test) });
  totals.push({ id: 'peak-walkers', label: 'Peak people walking (hourly average)', baseline: Math.round(Math.max(...a)), scenario: Math.round(Math.max(...b)) });
  return { hours: a.map((value, hour) => ({ hour, baseline: Math.round(value), scenario: Math.round(b[hour]) })), busier, quieter, totals };
}
