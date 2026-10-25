// Precompute the fire drill the public landing page shows, from the same model the map runs.
// Every number written comes from running the simulation code below; nothing is typed in by hand.
//
// The day is the one the map plays first for a weekday of the reference week: the population
// (buildPopulation), its source day with that date's campus events (buildSourceDay) and the same
// published timetable. The map later swaps in the conditions engine's day, but that one depends on
// live weather, so it cannot be reproduced offline. This is also the day event-impact.json uses.
// The drill is applyIncident('fire-drill') with the incident panel's defaults (30 minutes) and the
// id the map gives an incident started at that second, so its hash-seeded reactions, stair times
// and decisions match a drill started from the map. No Math.random: reruns give the same numbers.
//
//   node scripts/build-landing-scenarios.mjs               Tuesday, alarm at 11:00
//   node scripts/build-landing-scenarios.mjs --at 14:00    another alarm time (HH:MM)
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { buildPopulation } = await import('../src/sim/population.ts');
const { buildSourceDay } = await import('../src/sim/sourceDay.ts');
const { createTransitService, mergeSchedules } = await import('../src/sim/transitService.ts');
const { expandDay, occupancyShare, Playback } = await import('../src/sim/playback.ts');
const { applyIncident } = await import('../src/sim/incidents.ts');
const { dateForWeekday, WEEKDAYS } = await import('../src/data/campusData.ts');
const { scheduleCoversDate } = await import('../src/transit/publishedSchedule.ts');

// The landing page talks about a Tuesday. Weekdays are Monday=0 (campusData.WEEKDAYS, buildSourceDay).
const WEEKDAY = 1;
// A mid-morning class hour; the building is picked from the data at this time, not named here.
const atArgument = process.argv.indexOf('--at');
const ALARM_CLOCK = atArgument > 0 ? process.argv[atArgument + 1] : '11:00';
if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(ALARM_CLOCK ?? '')) throw new Error('--at takes a time as HH:MM');
const ALARM_AT = Number(ALARM_CLOCK.slice(0, 2)) * 3600 + Number(ALARM_CLOCK.slice(3)) * 60;
// IncidentPanel's default duration for a fire drill (simulated minutes).
const DRILL_MINUTES = 30;
// The drilled location plus this many other places: first the rest of its footprint (evacuated too),
// then the largest absolute changes in head count.
const OTHER_PLACES = 4;

const dataDir = new URL('../public/data/', import.meta.url);
const outputUrl = new URL('landing-scenarios.json', dataDir);
const read = (name) => JSON.parse(readFileSync(new URL(`${name}.json`, dataDir)));
const clock = (seconds) => `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}`;
const share = (count, capacity) => Math.round(occupancyShare(count, capacity) * 10000) / 10000;

const started = Date.now();
const source = read('campus-data');
const base = buildPopulation(expandDay(read('demo-day')), source, read('population'));
// As App.tsx: the merged MBTA and shuttle timetable is used only when it covers the whole reference week.
const timetable = mergeSchedules(read('transit-schedule'), read('shuttle-schedule'));
const covered = Array.from({ length: 7 }, (_, weekday) => dateForWeekday(source, weekday)).every((date) => scheduleCoversDate(timetable, date));
const transit = covered ? createTransitService(timetable) : undefined;
const date = dateForWeekday(source, WEEKDAY);
const day = buildSourceDay(base, source, WEEKDAY, transit, { eventDate: date });
const baseline = new Playback(day);

// The busiest academic building on the Charles River campus when the alarm sounds: the classroom
// location with the most people in it (ties by id, so the pick is stable).
const atAlarm = baseline.occupancyAt(ALARM_AT)
  .filter(({ location }) => location.kind === 'classroom' && (location.campus ?? 'charles-river') === 'charles-river')
  .sort((a, b) => b.count - a.count || a.location.id.localeCompare(b.location.id));
const target = atAlarm[0].location;

// Same id form as App.tsx's startIncident, so this is the drill the map would run at that second.
const incident = { id: `incident-${WEEKDAY}-${ALARM_AT}`, kind: 'fire-drill', locationId: target.id, start: ALARM_AT, duration: DRILL_MINUTES * 60 };
const result = applyIncident(day, incident, { sourceData: source, weekday: WEEKDAY, ...(transit ? { transit } : {}) });
const drilled = new Playback(result.day);

// Measure once the model has emptied the building: the first whole minute after the last occupant
// leaves (exit flow is shared per footprint, so a full building takes a while to clear). Before
// that the count is mid-queue; after release people start walking back in.
const occupants = result.participants.filter((participant) => participant.role === 'occupant');
const clearedAt = Math.max(...occupants.map((participant) => participant.departAt));
const MEASURED_AT = Math.ceil(clearedAt / 60) * 60;

const before = new Map(baseline.occupancyAt(MEASURED_AT).map((entry) => [entry.location.id, entry.count]));
const after = drilled.occupancyAt(MEASURED_AT);
const assemblyId = result.assemblyLocation?.id;
const changes = after
  .map(({ location, count }) => ({ location, beforeCount: before.get(location.id) ?? 0, afterCount: count }))
  .filter((entry) => entry.afterCount !== entry.beforeCount);
// The modeled assembly point is an outdoor spot with no capacity (so no share): reported on its own.
const assembly = changes.find((entry) => entry.location.id === assemblyId);
const others = changes
  .filter((entry) => entry.location.id !== target.id && entry.location.id !== assemblyId)
  .sort((a, b) => Number(b.location.building === target.building) - Number(a.location.building === target.building)
    || Math.abs(b.afterCount - b.beforeCount) - Math.abs(a.afterCount - a.beforeCount) || a.location.id.localeCompare(b.location.id))
  .slice(0, OTHER_PLACES);
const targetRow = { location: target, beforeCount: before.get(target.id) ?? 0, afterCount: after.find((entry) => entry.location.id === target.id).count };

const place = ({ location, beforeCount, afterCount }) => ({
  id: location.id, name: location.name, short: location.short, kind: location.kind,
  sameBuilding: location.building === target.building,
  // The map's crowd percentage is occupancyShare(count, location.capacity) on these same locations.
  capacity: location.capacity, beforeCount, afterCount,
  before: share(beforeCount, location.capacity), after: share(afterCount, location.capacity),
});
const outcomes = {};
for (const participant of result.participants) {
  const key = `${participant.role}-${participant.decision?.action ?? participant.outcome}`;
  outcomes[key] = (outcomes[key] ?? 0) + 1;
}

const output = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  generatedBy: 'map-client/scripts/build-landing-scenarios.mjs',
  model: `Flowcast's unconditioned simulated ${WEEKDAYS[WEEKDAY]} (buildPopulation + buildSourceDay with ${date}'s campus events and the published timetable), `
    + 'then applyIncident fire-drill with the map\'s default 30 minutes. Deterministic: seeded by hashes of the incident id and agent ids, no Math.random.',
  fireDrill: {
    kind: 'fire-drill', incidentId: incident.id,
    date, weekday: WEEKDAY, weekdayName: WEEKDAYS[WEEKDAY],
    alarmAt: clock(ALARM_AT), durationMinutes: DRILL_MINUTES, reopensAt: clock(result.endsAt),
    measuredAt: clock(MEASURED_AT), measuredAfterMinutes: (MEASURED_AT - ALARM_AT) / 60,
    choice: {
      building: `Charles River classroom location with the most simulated people at ${clock(ALARM_AT)} on the baseline day `
        + `(${atAlarm[0].count} of ${target.capacity}; next: ${atAlarm.slice(1, 3).map((entry) => `${entry.location.short} ${entry.count}`).join(', ')}).`,
      measuredAt: 'First whole minute after the model\'s last occupant leaves the building, i.e. when the drilled building first reads empty.',
      places: `The drilled location, then up to ${OTHER_PLACES} other places with a changed head count at measuredAt (day with vs without the drill): `
        + 'other locations in the same footprint first, then by largest absolute change. The assembly point has no capacity and is reported separately.',
    },
    building: { id: target.id, name: target.name, short: target.short, capacity: target.capacity },
    evacuated: occupants.length,
    affectedPeople: result.affectedAgents,
    outcomes,
    assembly: {
      name: result.assemblyLocation?.name ?? null,
      position: result.assemblyLocation?.position ?? null,
      count: assembly?.afterCount ?? 0,
      note: 'Modeled point on saved pedestrian geometry outside every footprint; not an official assembly area, capacity unknown.',
    },
    places: [targetRow, ...others].map(place),
  },
};
const temporary = new URL('landing-scenarios.json.tmp', dataDir);
writeFileSync(temporary, JSON.stringify(output, null, 2) + '\n');
renameSync(temporary, outputUrl);

// Ids the dashboard's event-impact.json does not know (the landing labels places from there).
const known = new Set(read('event-impact').places.map((entry) => entry.id));
const unknown = output.fireDrill.places.filter((entry) => !known.has(entry.id)).map((entry) => entry.id);
console.log(`${WEEKDAYS[WEEKDAY]} ${date}: fire drill at ${target.short} ${clock(ALARM_AT)}, measured ${clock(MEASURED_AT)}`);
for (const entry of output.fireDrill.places) {
  console.log(`  ${entry.short.padEnd(28)} ${String(entry.beforeCount).padStart(5)} → ${String(entry.afterCount).padStart(5)} of ${entry.capacity}  (${(entry.before * 100).toFixed(1)}% → ${(entry.after * 100).toFixed(1)}%)`);
}
console.log(`  ${'Assembly point'.padEnd(28)} ${String(0).padStart(5)} → ${String(output.fireDrill.assembly.count).padStart(5)}`);
if (unknown.length) console.log(`Not in event-impact.json places: ${unknown.join(', ')}`);
console.log(`Wrote landing-scenarios.json in ${Math.round((Date.now() - started) / 1000)} s`);
