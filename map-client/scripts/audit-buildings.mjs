import { registerHooks } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { buildPopulation } = await import('../src/sim/population.ts');
const { buildSourceDay } = await import('../src/sim/sourceDay.ts');
const { openingHoursForDate, dateForWeekday } = await import('../src/data/campusData.ts');
const read = name => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url)));
const source = read('campus-data');
const base = buildPopulation(read('demo-day'), source, read('population'));
const rows = base.locations.map(location => ({
  id: location.id, name: location.name, kind: location.kind,
  modeled: location.activityModeled !== false, capacity: location.capacity,
  capacityBasis: location.capacityBasis,
  estimate: location.estimatedProfile ?? location.estimatedHousingProfile ?? null,
  homes: base.agents.filter(agent => agent.home === location.id).length,
  classAssignments: 0, optionalVisits: 0, estimatedVisits: 0, peak: 0, peakDate: null,
  peakTime: null, minutesOverReference: 0, outsideHoursVisits: 0,
}));
const byId = new Map(rows.map(row => [row.id, row]));
for (let weekday = 0; weekday < 7; weekday++) {
  const day = buildSourceDay(base, source, weekday);
  const date = dateForWeekday(source, weekday);
  const events = new Map(rows.map(row => [row.id, []]));
  for (const stay of day.stays) {
    events.get(stay.location)?.push([stay.start, 1], [stay.end, -1]);
  }
  for (const assignment of day.sourceAssignments) byId.get(assignment.locationId).classAssignments++;
  for (const activity of day.sourceActivities) {
    const row = byId.get(activity.locationId);
    if (!row) continue;
    row.optionalVisits++;
    if (activity.kind === 'estimated') row.estimatedVisits++;
    const windows = activity.kind === 'estimated'
      ? row.estimate.weekdayWindows.filter(day => day.weekday === weekday).flatMap(day => day.windows)
      : openingHoursForDate(source.locations[row.id]?.hours ?? [], date, weekday).flatMap(hours => hours.windows);
    if (!windows.some(([start, end]) => start <= activity.startSec && activity.endSec <= end)) row.outsideHoursVisits++;
  }
  for (const [id, changes] of events) {
    changes.sort((a, b) => a[0] - b[0]);
    const row = byId.get(id);
    let count = 0, last = 0;
    for (let i = 0; i < changes.length;) {
      const time = changes[i][0];
      if (row.capacity > 0 && count > row.capacity) row.minutesOverReference += (time - last) / 60;
      if (count > row.peak) {
        row.peak = count;
        row.peakDate = date;
        row.peakTime = new Date(last * 1000).toISOString().slice(11, 19);
      }
      while (i < changes.length && changes[i][0] === time) count += changes[i++][1];
      last = time;
    }
  }
}
const report = { population: base.agents.length, locations: rows };
writeFileSync(new URL('../audits/building-behavior.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
const lines = [
  '# Building behavior audit', '',
  'Run: `node map-client/scripts/audit-buildings.mjs` (Node 26). Uses saved datasets; no scraping.', '',
  'All 50 mapped locations, Monday–Sunday of the source reference week. Peaks use exact stay boundaries, not sampled snapshots. Population: ' + base.agents.length + '.', '',
  'Classroom capacities are room-seat references, not whole-building occupancy limits. Optional venue capacities remain modeling assumptions where no published capacity exists. Estimated profiles fill gaps using existing students, purpose-specific schedules, and estimated housing allocations; their metadata is included in JSON. These are low-confidence estimates, not observed attendance. Fenway housing estimates distribute the existing planned relocation cohort rather than adding people.', '',
  '| Location | Coverage | Reference capacity | Weekly peak | Class assignments | Optional visits | Minutes above reference | Visits outside hours |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...rows.map(row => `| ${row.name} | ${row.estimate ? 'Estimated' : row.modeled ? 'Partial model' : 'Not modeled'} | ${row.capacity} | ${row.peak} | ${row.classAssignments} | ${row.optionalVisits} | ${Math.round(row.minutesOverReference)} | ${row.outsideHoursVisits} |`),
  '', 'Assignments and visits count attendance episodes across the week, not distinct people. JSON includes capacity basis, estimate assumptions, and peak time for every location. Outside-hours checks use published windows for sourced activities and explicitly estimated windows for estimated activities.', '',
];
writeFileSync(new URL('../audits/building-behavior.md', import.meta.url), lines.join('\n'));
console.log(JSON.stringify({ locations: rows.length, unmodeled: rows.filter(row => !row.modeled).length,
  aboveReference: rows.filter(row => row.minutesOverReference > 0).map(row => row.id),
  outsideHours: rows.filter(row => row.outsideHoursVisits > 0).map(row => row.id) }));
