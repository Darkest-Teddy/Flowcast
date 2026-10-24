import { registerHooks } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const root = resolve(process.argv[2] ?? 'map-client');
const { buildPopulation } = await import(pathToFileURL(`${root}/src/sim/population.ts`));
const { buildSourceDay } = await import(pathToFileURL(`${root}/src/sim/sourceDay.ts`));
const read = name => JSON.parse(readFileSync(`${root}/public/data/${name}.json`));
const source = read('campus-data');
const base = buildPopulation(read('demo-day'), source, read('population'));
const rows = base.locations.map(location => ({ id: location.id, kind: location.kind,
  capacity: location.capacity, samples: 0, unknown: 0, empty: 0, nearFull: 0, middle: 0, sum: 0, peak: 0 }));
const byId = new Map(rows.map(row => [row.id, row]));
const days = [];
for (let weekday = 0; weekday < 7; weekday++) {
  const day = buildSourceDay(base, source, weekday);
  const timelines = new Map(base.agents.map(agent => [agent.id, []]));
  for (const stay of day.stays) {
    assert.ok(timelines.has(stay.agent), `Unknown person: ${stay.agent}`);
    timelines.get(stay.agent).push([stay.start, stay.end]);
  }
  for (const trip of day.trips) {
    assert.ok(timelines.has(trip.agent), `Unknown walker: ${trip.agent}`);
    const start = trip.timestamps[0], end = trip.timestamps.at(-1);
    assert.ok(end > start, `Nonpositive travel time: ${trip.agent}`);
    timelines.get(trip.agent).push([start, end]);
  }
  for (const [id, intervals] of timelines) {
    intervals.sort((a, b) => a[0] - b[0]);
    let end = 0;
    for (const [start, finish] of intervals) {
      assert.ok(Math.abs(start - end) < .001, `Timeline gap/overlap: day ${weekday}, ${id}, ${end}→${start}`);
      assert.ok(finish >= start && finish <= 86400, `Invalid interval: ${id}`);
      end = finish;
    }
    assert.equal(end, 86400, `Incomplete day: ${id}`);
  }
  const unknown = new Set(day.locations.filter(location => location.activityModeled === false).map(location => location.id));
  const events = day.stays.flatMap(stay => byId.has(stay.location)
    ? [[stay.start, stay.location, 1], [stay.end, stay.location, -1]] : []).sort((a, b) => a[0] - b[0]);
  const counts = new Map();
  const snapshots = [];
  let cursor = 0;
  // Compare identical daytime samples; zeros at closed venues remain visible, not a failure by themselves.
  for (let time = 8 * 3600; time <= 22 * 3600; time += 15 * 60) {
    while (cursor < events.length && events[cursor][0] <= time) {
      const [, id, delta] = events[cursor++];
      counts.set(id, (counts.get(id) ?? 0) + delta);
    }
    for (const row of rows) {
      if (unknown.has(row.id)) { row.unknown++; continue; }
      const count = counts.get(row.id) ?? 0;
      const share = row.capacity > 0 ? count / row.capacity : 0;
      row.samples++; row.sum += share; row.peak = Math.max(row.peak, share);
      if (!count) row.empty++;
      else if (share >= .9) row.nearFull++;
      else row.middle++;
    }
    if ([9, 11.5, 15, 18].includes(time / 3600)) snapshots.push({ time,
      locations: rows.map(row => ({ id: row.id, count: counts.get(row.id) ?? 0, capacity: row.capacity, modeled: !unknown.has(row.id) })) });
  }
  days.push({ weekday, assignments: day.sourceAssignments.length, activities: day.sourceActivities.length,
    stats: day.sourceStats, snapshots });
}
const report = { population: base.agents.length, sample: 'Every 15 minutes, 08:00–22:00, Monday–Sunday',
  interpretation: 'Empty includes legitimately closed venues. Capacity and catalog coverage are not measured attendance.',
  locations: rows.map(({ sum, ...row }) => ({ ...row, meanShare: sum / row.samples })), days };
const output = process.argv[3];
if (output) writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ population: report.population, samples: rows.reduce((n, r) => n + r.samples, 0),
  empty: rows.reduce((n, r) => n + r.empty, 0), nearFull: rows.reduce((n, r) => n + r.nearFull, 0),
  middle: rows.reduce((n, r) => n + r.middle, 0), weeklyEnrollments: days[0].stats.weeklyEnrollments,
  locations: report.locations.map(r => ({ id: r.id, empty: r.empty, nearFull: r.nearFull, meanShare: +r.meanShare.toFixed(3) })) }));
