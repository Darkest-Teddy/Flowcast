// Precompute how campus events change crowding, for the dashboard's event-impact tab.
// For each weekday: the no-event baseline. For each date with simulated events: the same day with
// those events. Values are hourly mean occupancy (overlap seconds / 3600, plan Section 5.8).
// Also: a finals-week projection per weekday (the conditions engine on the term's exam and study
// dates) and simulated walkers passing outdoor spots (plazas, lawns, the river path) per hour.
//
//   node scripts/build-event-impact.mjs            rebuild
//   node scripts/build-event-impact.mjs --if-stale skip when inputs are unchanged (used by prepare:data)
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { buildPopulation } = await import('../src/sim/population.ts');
const { buildSourceDay } = await import('../src/sim/sourceDay.ts');
const { createTransitService, mergeSchedules } = await import('../src/sim/transitService.ts');
const { GATHERING_ASSUMPTIONS, GATHERING_ATTENDANCE_PROBABILITY, gatheringExclusion, gatheringsOnDate, weekdayOf } = await import('../src/sim/gatherings.ts');
const { conditionsFor } = await import('../src/sim/conditions.ts');
const { simulatedPedestrians } = await import('../src/data/observations.ts');
const { splitResidences, splitResidenceStays } = await import('../src/sim/residenceSplit.ts');

const dataDir = new URL('../public/data/', import.meta.url);
const outputUrl = new URL('event-impact.json', dataDir);
const inputs = ['campus-data', 'demo-day', 'population', 'transit-schedule', 'shuttle-schedule', 'behavior', 'personas', 'outdoor', 'monuments']
  .map(name => readFileSync(new URL(`${name}.json`, dataDir)));
const code = ['sim/sourceDay.ts', 'sim/gatherings.ts', 'sim/population.ts', 'sim/transitService.ts', 'sim/conditions.ts', 'sim/behavior.ts', 'sim/residenceSplit.ts', 'data/observations.ts']
  .map(name => readFileSync(new URL(`../src/${name}`, import.meta.url)));
const inputHash = createHash('sha256').update(Buffer.concat([...inputs, ...code])).digest('hex');
if (process.argv.includes('--if-stale') && existsSync(outputUrl) && JSON.parse(readFileSync(outputUrl)).inputHash === inputHash) {
  console.log('event-impact.json is up to date');
  process.exit(0);
}

const [source, demoDay, population, mbta, shuttle, behavior, personas, outdoor, monuments] = inputs.map(body => JSON.parse(body));
const base = buildPopulation(demoDay, source, population);
// Same timetable as the map, so commuters ride the same scheduled trips in both.
const transit = createTransitService(mergeSchedules(mbta, shuttle));
// The same split as each simulated day (sim/residenceSplit.ts): Kilachand's dorm and its classrooms are two places.
const places = splitResidences(base.locations).filter(location => location.kind !== 'off-campus');

/** Hourly mean head count per place; places that are empty all day are omitted. */
function hourlyOccupancy(day) {
  const seconds = new Map();
  // Residences with classrooms are counted as dorm + classrooms, like the places list.
  for (const stay of splitResidenceStays(day.stays, day.locations)) {
    if (stay.location === 'off-campus') continue;
    let row = seconds.get(stay.location);
    if (!row) { row = new Float64Array(24); seconds.set(stay.location, row); }
    for (let hour = Math.floor(stay.start / 3600); hour < Math.min(24, Math.ceil(stay.end / 3600)); hour++) {
      row[hour] += Math.max(0, Math.min(stay.end, (hour + 1) * 3600) - Math.max(stay.start, hour * 3600));
    }
  }
  return Object.fromEntries([...seconds].map(([id, row]) => [id, [...row].map(value => Math.round(value / 3600))]).filter(([, row]) => row.some(Boolean)));
}

// Outdoor spots with an outline: walkers entering a circle of the spot's area plus a 10 m edge count once per pass.
const radiusFor = polygon => {
  if (!polygon?.length) return null;
  const [lng0, lat0] = polygon[0], kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  let area = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i], [x2, y2] = polygon[(i + 1) % polygon.length];
    area += ((x1 - lng0) * kx) * ((y2 - lat0) * ky) - ((x2 - lng0) * kx) * ((y1 - lat0) * ky);
  }
  return Math.round(Math.sqrt(Math.abs(area / 2) / Math.PI) + 10);
};
const marsh = monuments.find(m => m.id === 'marsh-plaza');
const outdoorSpots = [
  ...(marsh ? [{ id: 'marsh-plaza', name: 'Marsh Plaza', kind: 'plaza', position: marsh.position, radiusMetres: radiusFor(marsh.polygon), source: marsh.source.position }] : []),
  ...outdoor.spots.map(spot => ({ id: spot.id.replace(/^outdoor:/, ''), name: spot.name, kind: spot.kind, position: spot.position,
    radiusMetres: radiusFor(spot.polygon) ?? 30, source: spot.source })),
  // Busy building fronts for tabling: a circle around the building's mapped position, so it counts people
  // walking past, in and out alike. Not a count at one door.
  ...[['gsu', 'Around the George Sherman Union'], ['cas', 'Around the College of Arts & Sciences'], ['questrom', 'Around Questrom']]
    .flatMap(([id, name]) => {
      const location = base.locations.find(l => l.id === id);
      return location ? [{ id: `around-${id}`, name, kind: 'building-front', locationId: id, position: location.position, radiusMetres: 30, source: 'Building position from the map data' }] : [];
    }),
];
const HOUR_BINS = Array.from({ length: 24 }, (_, h) => ({ start: `${String(h).padStart(2, '0')}:00`, end: `${String(h + 1).padStart(2, '0')}:00`, value: 0 }));
const passersBy = day => Object.fromEntries(outdoorSpots.map(spot => [spot.id,
  simulatedPedestrians(day.trips, { id: `foot:${spot.id}`, site: spot.name, position: spot.position, screen: { type: 'cordon', radiusMetres: spot.radiusMetres },
    date: '', dayType: 'weekday', bins: HOUR_BINS, unit: 'people', direction: null, source: '', expectedStudentShare: [0, 1] })]));

const started = Date.now();
const baseline = {};
const footBaseline = {};
for (let weekday = 0; weekday < 7; weekday++) {
  const day = buildSourceDay(base, source, weekday, transit);
  baseline[weekday] = hourlyOccupancy(day);
  footBaseline[weekday] = passersBy(day);
}

// Finals week with the conditions engine: Monday-Friday on the exam dates, the weekend on the study period.
// The weather is pinned (no forecast exists for December) and stated as an assumption.
const FINALS_WEATHER = { condition: 'clear', temperatureF: 40 };
const term = source.academicCalendar?.terms?.find(row => row.term === source.term?.toUpperCase());
const eventDays = kind => (term?.events ?? []).filter(event => event.kind === kind)
  .flatMap(event => { const out = []; for (let d = new Date(`${event.start}T12:00:00Z`); d <= new Date(`${event.end}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10)); return out; });
const examDates = eventDays('exams'), studyDates = eventDays('study');
const examStart = examDates[0], examEnd = examDates.at(-1);
const examWeek = [];
if (examStart) for (let d = new Date(`${examStart}T12:00:00Z`); d.toISOString().slice(0, 10) <= examEnd; d.setUTCDate(d.getUTCDate() + 1)) examWeek.push(d.toISOString().slice(0, 10));
let finals = null;
if (examWeek.length) {
  const model = { behavior, personas, outdoor };
  const dateFor = weekday => examWeek.find(date => weekdayOf(date) === weekday) ?? studyDates.find(date => weekdayOf(date) === weekday) ?? null;
  const days = {}, foot = {};
  for (let weekday = 0; weekday < 7; weekday++) {
    const date = dateFor(weekday);
    if (!date) continue;
    const conditions = conditionsFor({ date, weekday, calendar: source.academicCalendar, weather: FINALS_WEATHER });
    const day = buildSourceDay(base, source, weekday, transit, { eventDate: date, conditions, model });
    days[weekday] = { date, period: conditions.period, occupancy: hourlyOccupancy(day) };
    foot[weekday] = passersBy(day);
    console.log(`finals ${WEEKDAY_NAMES[weekday]} ${date} (${conditions.period})`);
  }
  finals = {
    term: term.term, studyPeriod: studyDates.length ? { start: studyDates[0], end: studyDates.at(-1) } : null, exams: { start: examStart, end: examEnd },
    weather: FINALS_WEATHER,
    assumptions: [
      'Finals behaviour rules from behavior.json (class attendance, library and evening study up, gym and outings down), calibrated only for plausibility, not against finals-week counts.',
      `Weather is assumed ${FINALS_WEATHER.condition} at ${FINALS_WEATHER.temperatureF}°F; no forecast exists this far ahead.`,
      'Exam meetings are not in the data: exam rooms and times are unknown.',
      'Library and dining hours for finals week are not published in the data; places with unknown hours are shown without an open/closed claim.',
    ],
    days, footTraffic: foot,
  };
}

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const dates = {};
const eventDates = [...new Set(source.events.map(event => event.start.slice(0, 10)))].filter(date => gatheringsOnDate(source, date).length).sort();
for (const date of eventDates) {
  const day = buildSourceDay(base, source, weekdayOf(date), transit, { eventDate: date });
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
  finals,
  footTraffic: {
    measure: 'Simulated people walking into each spot\'s circle per hour (each pass counts once), not people staying there and not measured counts.',
    spots: outdoorSpots, baseline: footBaseline,
  },
};
const temporary = new URL('event-impact.json.tmp', dataDir);
writeFileSync(temporary, JSON.stringify(output) + '\n');
renameSync(temporary, outputUrl);
console.log(`Wrote event-impact.json: ${eventDates.length} event dates in ${Math.round((Date.now() - started) / 1000)} s`);
