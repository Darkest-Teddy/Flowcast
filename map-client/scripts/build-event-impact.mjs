// Precompute how campus events change crowding, for the dashboard's event-impact tab.
// For each weekday: the no-event baseline. For each date with simulated events: the same day with
// those events. Values are hourly mean occupancy (overlap seconds / 3600, plan Section 5.8).
//
//   node scripts/build-event-impact.mjs            rebuild
//   node scripts/build-event-impact.mjs --if-stale skip when inputs are unchanged (used by prepare:data)
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { buildPopulation } = await import('../src/sim/population.ts');
const { buildSourceDay } = await import('../src/sim/sourceDay.ts');
const { GATHERING_ASSUMPTIONS, GATHERING_ATTENDANCE_PROBABILITY, gatheringExclusion, gatheringsOnDate, weekdayOf } = await import('../src/sim/gatherings.ts');

const dataDir = new URL('../public/data/', import.meta.url);
const outputUrl = new URL('event-impact.json', dataDir);
const inputs = ['campus-data', 'demo-day', 'population'].map(name => readFileSync(new URL(`${name}.json`, dataDir)));
const code = ['sourceDay.ts', 'gatherings.ts', 'population.ts'].map(name => readFileSync(new URL(`../src/sim/${name}`, import.meta.url)));
const inputHash = createHash('sha256').update(Buffer.concat([...inputs, ...code])).digest('hex');
if (process.argv.includes('--if-stale') && existsSync(outputUrl) && JSON.parse(readFileSync(outputUrl)).inputHash === inputHash) {
  console.log('event-impact.json is up to date');
  process.exit(0);
}

const [source, demoDay, population] = inputs.map(body => JSON.parse(body));
const base = buildPopulation(demoDay, source, population);
const places = base.locations.filter(location => location.kind !== 'off-campus');

/** Hourly mean head count per place; places that are empty all day are omitted. */
function hourlyOccupancy(day) {
  const seconds = new Map();
  for (const stay of day.stays) {
    if (stay.location === 'off-campus') continue;
    let row = seconds.get(stay.location);
    if (!row) { row = new Float64Array(24); seconds.set(stay.location, row); }
    for (let hour = Math.floor(stay.start / 3600); hour < Math.min(24, Math.ceil(stay.end / 3600)); hour++) {
      row[hour] += Math.max(0, Math.min(stay.end, (hour + 1) * 3600) - Math.max(stay.start, hour * 3600));
    }
  }
  return Object.fromEntries([...seconds].map(([id, row]) => [id, [...row].map(value => Math.round(value / 3600))]).filter(([, row]) => row.some(Boolean)));
}

const started = Date.now();
const baseline = {};
for (let weekday = 0; weekday < 7; weekday++) baseline[weekday] = hourlyOccupancy(buildSourceDay(base, source, weekday));

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const dates = {};
const eventDates = [...new Set(source.events.map(event => event.start.slice(0, 10)))].filter(date => gatheringsOnDate(source, date).length).sort();
for (const date of eventDates) {
  const day = buildSourceDay(base, source, weekdayOf(date), { eventDate: date });
  const occupancy = hourlyOccupancy(day);
  const before = baseline[weekdayOf(date)];
  // Keep only places the events changed; everything else equals the weekday baseline.
  const changed = Object.fromEntries(Object.entries(occupancy).filter(([id, row]) => row.some((value, hour) => value !== (before[id]?.[hour] ?? 0))));
  for (const id of Object.keys(before)) if (!occupancy[id]) changed[id] = Array(24).fill(0);
  dates[date] = { weekday: weekdayOf(date), projected: day.gatherings.some(g => g.projected), occupancy: changed,
    gatherings: day.gatherings.map(({ eventId, name, locationId, startSec, endSec, attendees, capacity, roomCode, endEstimated }) =>
      ({ eventId, name, locationId, startSec, endSec, attendees, capacity, roomCode, endEstimated })) };
  console.log(`${date}: ${day.gatherings.map(g => `${g.locationId} ${g.attendees}/${g.capacity}`).join(', ')}`);
}

const status = event => !event.locationName ? 'location-hidden' : gatheringExclusion(event) ?? 'simulated';
const output = {
  schemaVersion: 1, inputHash, referenceWeekStart: source.referenceWeekStart, builtFor: today,
  attendanceProbability: GATHERING_ATTENDANCE_PROBABILITY,
  measure: 'Hourly mean simulated head count (overlap seconds / 3600). Not measured occupancy.',
  assumptions: GATHERING_ASSUMPTIONS,
  places: places.map(({ id, name, short, kind, campus, capacity }) => ({ id, name, short, kind, campus: campus ?? 'charles-river', capacity })),
  events: source.events.map(event => ({ id: event.id, name: event.name, start: event.start, end: event.end, organizer: event.organizer ?? null,
    locationId: event.locationId, locationName: event.locationName, roomCode: event.roomCode ?? null, sourceUrl: event.sourceUrl, status: status(event) })),
  baseline, dates,
};
const temporary = new URL('event-impact.json.tmp', dataDir);
writeFileSync(temporary, JSON.stringify(output) + '\n');
renameSync(temporary, outputUrl);
console.log(`Wrote event-impact.json: ${eventDates.length} event dates in ${Math.round((Date.now() - started) / 1000)} s`);
