import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context);
    throw error;
  }
}});
const { buildPopulation } = await import('../src/sim/population.ts');
const { buildSourceDay } = await import('../src/sim/sourceDay.ts');
const { Playback } = await import('../src/sim/playback.ts');
const { openingHoursForDate, dateForWeekday } = await import('../src/data/campusData.ts');
const read = name => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url)));

test('bundled population and weekly schedules conserve all people and physical trip speeds', () => {
  const source = read('campus-data');
  const base = buildPopulation(read('demo-day'), source, read('population'));
  const mapped = new Set(base.locations.map(l => l.id));
  const gateways = new Set(Object.values(base.stopRoutes ?? {}).map(route => JSON.stringify(route.path[0])));
  let checkedTrips = 0;
  for (let weekday = 0; weekday < 7; weekday++) {
    const day = buildSourceDay(base, source, weekday);
    const playback = new Playback(day);
    assert.ok(day.sourceStats.modeledOffCampusMeals > 0, 'off-campus meals are represented without adding people');
    for (const activity of day.sourceActivities) {
      if (activity.kind === 'off-campus-meal') continue;
      const windows = openingHoursForDate(source.locations[activity.locationId]?.hours ?? [], dateForWeekday(source,weekday),weekday).flatMap(h=>h.windows);
      assert.ok(windows.some(([start,end])=>start<=activity.startSec && activity.endSec<=end), `${activity.locationId} optional visits require published hours`);
    }
    const agents = new Map(day.agents.map(a => [a.id,a]));
    const diningHours = new Map(day.locations.filter(l=>l.kind==='dining').map(l=>[l.id,
      openingHoursForDate(source.locations[l.id]?.hours ?? [], dateForWeekday(source,weekday),weekday).flatMap(h=>h.windows)]));
    for (const stay of day.stays) {
      if (!diningHours.has(stay.location)) continue;
      assert.ok(diningHours.get(stay.location).some(([start,end])=>start<=stay.start && stay.end<=end), `${stay.location} dining stays must fit their entire opening window`);
    }
    const timelines = new Map(day.agents.map(a => [a.id, []]));
    for (const stay of day.stays) timelines.get(stay.agent).push([stay.start, stay.end]);
    for (const trip of day.trips) timelines.get(trip.agent).push([trip.timestamps[0],trip.timestamps.at(-1)]);
    for (const intervals of timelines.values()) {
      intervals.sort((a,b) => a[0]-b[0] || a[1]-b[1]);
      let end = 0;
      for (const interval of intervals) {
        assert.ok(Math.abs(interval[0]-end) < 1e-7, 'every person has one location or trip at all times');
        end = interval[1];
      }
      assert.equal(end,86400);
    }
    for (let time = 0; time < 86400; time += 900) {
      const counts = playback.populationAt(time);
      assert.equal(counts.total, 36977);
      assert.ok(counts.offCampus >= 0);
      assert.equal(counts.indoors + counts.walking + counts.offCampus, counts.total);
      assert.ok(playback.occupancyAt(time).every(o => Number.isFinite(o.share)));
      for (const occupancy of playback.occupancyAt(time).filter(o => o.location.kind === 'dining')) {
        const hours = openingHoursForDate(source.locations[occupancy.location.id]?.hours ?? [], dateForWeekday(source, weekday), weekday);
        if (!hours.some(h => h.windows.some(([start,end]) => start <= time && time < end))) {
          assert.equal(occupancy.count, 0, `${occupancy.location.id} cannot host diners outside verified hours`);
        }
      }
      for (const id of ['agganis', 'dewolfe']) assert.equal(playback.occupancyAt(time).find(o => o.location.id === id)?.count ?? 0, 0);
    }
    for (const trip of day.trips) {
      assert.ok(mapped.has(trip.from) || trip.from === 'off-campus');
      assert.ok(mapped.has(trip.to) || trip.to === 'off-campus');
      if (trip.from === 'off-campus') assert.ok(gateways.has(JSON.stringify(trip.path[0])));
      if (trip.to === 'off-campus') assert.ok(gateways.has(JSON.stringify(trip.path.at(-1))));
      const speed = agents.get(trip.agent).walkSpeed;
      assert.equal(speed, 1.4);
      const route = base.walkRoutes[`${trip.from}>${trip.to}`];
      if (route) {
        assert.ok(Math.abs((trip.timestamps.at(-1)-trip.timestamps[0])*speed-route.cumulative.at(-1)) < 1e-6);
      }
      checkedTrips++;
    }
    assert.deepEqual(day.locations.map(l=>l.capacity), base.locations.map(l=>l.capacity));
  }
  assert.ok(checkedTrips > 10000);
  console.log(`Verified ${checkedTrips} trips and 672 population snapshots across seven days`);
});
