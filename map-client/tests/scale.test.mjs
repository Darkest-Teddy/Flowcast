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
const { buildSourceDay, venueWindows } = await import('../src/sim/sourceDay.ts');
const { Playback } = await import('../src/sim/playback.ts');
const { carriedForwardHours, openingHoursForDate, dateForWeekday } = await import('../src/data/campusData.ts');
const read = name => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url)));

test('bundled population and weekly schedules conserve all people and physical trip speeds', () => {
  const source = read('campus-data');
  const base = buildPopulation(read('demo-day'), source, read('population'));
  const mapped = new Set(base.locations.map(l => l.id));
  const gateways = new Set(Object.values(base.stopRoutes ?? {}).map(route => JSON.stringify(route.path[0])));
  const estimatedVisits = new Map();
  let checkedTrips = 0, alternativeTrips = 0, directPairTrips = 0;
  const speedOf = new Map();
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  const alternatives = new Map();
  /** Lengths of the ways a trip's path joins two saved walk routes at another place's entrance. */
  const alternativeLengths = trip => {
    if (alternatives.has(trip.path)) return alternatives.get(trip.path);
    const lengths = [];
    for (const via of base.locations.map(l => l.id)) {
      const first = base.walkRoutes[`${trip.from}>${via}`], second = base.walkRoutes[`${via}>${trip.to}`];
      if (!first || !second || first.path.length + second.path.length - 1 !== trip.path.length) continue;
      if (first.path.every((point, i) => same(point, trip.path[i])) && second.path.every((point, i) => same(point, trip.path[first.path.length - 1 + i]))) {
        lengths.push(first.cumulative.at(-1) + second.cumulative.at(-1));
      }
    }
    alternatives.set(trip.path, lengths); return lengths;
  };
  for (let weekday = 0; weekday < 7; weekday++) {
    const day = buildSourceDay(base, source, weekday);
    const playback = new Playback(day);
    assert.ok(day.sourceStats.modeledOffCampusMeals > 0, 'off-campus meals are represented without adding people');
    for (const activity of day.sourceActivities) {
      if (activity.kind === 'off-campus-meal') continue;
      if (activity.kind === 'off-campus-outing') { assert.equal(activity.locationId, 'off-campus'); assert.ok(weekday >= 4, 'outings are Friday/Saturday only'); continue; }
      if (activity.kind === 'unmapped-academic') {
        const site = base.locations.find(location => location.id === activity.locationId);
        assert.ok(activity.locationId === 'off-campus' || site?.kind === 'library' || site?.kind === 'classroom', `${activity.locationId} is not a study site`);
        assert.equal(activity.estimated, true);
        assert.equal(activity.basis, 'modeled_unmapped_academic_time');
        assert.equal(activity.endSec - activity.startSec, 120 * 60);
        continue;
      }
      if (activity.kind === 'estimated') {
        const profile = base.locations.find(location => location.id === activity.locationId)?.estimatedProfile;
        assert.ok(profile && activity.estimated && profile.confidence === 'low');
        assert.ok(profile.weekdayWindows.filter(day => day.weekday === weekday).flatMap(day => day.windows)
          .some(([start, end]) => start <= activity.startSec && activity.endSec <= end));
        estimatedVisits.set(activity.locationId, (estimatedVisits.get(activity.locationId) ?? 0) + 1);
        continue;
      }
      const hours = source.locations[activity.locationId]?.hours ?? [], date = dateForWeekday(source,weekday);
      const published = openingHoursForDate(hours,date,weekday);
      const windows = (published.length ? published : carriedForwardHours(hours,date,weekday)).flatMap(h=>h.windows);
      assert.ok(windows.some(([start,end])=>start<=activity.startSec && activity.endSec<=end), `${activity.locationId} optional visits require published or carried-forward hours`);
    }
    const agents = new Map(day.agents.map(a => [a.id,a]));
    const diningHours = new Map(day.locations.filter(l=>l.kind==='dining').map(l=>[l.id, venueWindows(source, l.id, l.kind, weekday, { carryForward: true })]));
    for (const stay of day.stays) {
      if (!diningHours.has(stay.location)) continue;
      assert.ok(diningHours.get(stay.location).some(([start,end])=>start<=stay.start && stay.end<=end), `${stay.location} dining stays must fit their entire opening window`);
    }
    for (const location of day.locations.filter(location => location.estimatedProfile)) {
      const profile = location.estimatedProfile;
      const windows = profile.weekdayWindows.filter(day => day.weekday === weekday).flatMap(day => day.windows);
      const stays = day.stays.filter(stay => stay.location === location.id);
      for (const stay of stays) assert.ok(windows.some(([start, end]) => start <= stay.start && stay.end <= end), `${location.id} complete stays fit estimated windows`);
      const changes = stays.flatMap(stay => [[stay.start, 1], [stay.end, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let count = 0;
      for (const [, delta] of changes) {
        count += delta;
        assert.ok(count <= Math.min(profile.capacity, location.capacity), `${location.id} stays within its attendance quota`);
      }
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
        const windows = venueWindows(source, occupancy.location.id, occupancy.location.kind, weekday, { carryForward: true });
        if (!windows.some(([start,end]) => start <= time && time < end)) {
          assert.equal(occupancy.count, 0, `${occupancy.location.id} cannot host diners outside its opening hours`);
        }
      }
      for (const occupancy of playback.occupancyAt(time).filter(o => o.location.estimatedProfile)) {
        assert.ok(occupancy.count <= occupancy.location.capacity, `${occupancy.location.id} estimated presence stays within capacity`);
      }
    }
    for (const trip of day.trips) {
      assert.ok(mapped.has(trip.from) || trip.from === 'off-campus');
      assert.ok(mapped.has(trip.to) || trip.to === 'off-campus');
      if (trip.from === 'off-campus') assert.ok(gateways.has(JSON.stringify(trip.path[0])));
      if (trip.to === 'off-campus') assert.ok(gateways.has(JSON.stringify(trip.path.at(-1))));
      // Each trip at its own walker's speed, along the shortest saved route or a near-equal one
      // joined at another place's entrance (at most 10% longer).
      const speed = agents.get(trip.agent).walkSpeed;
      assert.ok(speed >= 1.1 && speed <= 1.6, `${trip.agent} walks at a plausible speed`);
      speedOf.set(trip.agent, speed);
      const route = base.walkRoutes[`${trip.from}>${trip.to}`];
      if (route) {
        const walked = (trip.timestamps.at(-1)-trip.timestamps[0])*speed;
        const lengths = trip.path === route.path ? [route.cumulative.at(-1)] : alternativeLengths(trip);
        assert.ok(lengths.some(metres => Math.abs(walked-metres) < 1e-6 && metres <= route.cumulative.at(-1) * 1.1 + 1e-6),
          `${trip.from}>${trip.to} walks a saved route or a near-equal alternative at its walker's speed`);
        if (trip.path !== route.path) alternativeTrips++;
        directPairTrips++;
      }
      checkedTrips++;
    }
    assert.deepEqual(day.locations.map(l=>l.capacity), base.locations.map(l=>l.capacity));
  }
  assert.equal(base.locations.filter(location => !location.activityModeled).length, 0);
  for (const location of base.locations.filter(location => location.estimatedProfile)) {
    assert.ok(estimatedVisits.get(location.id) > 0, `${location.id} has estimated activity during the week`);
  }
  for (const location of base.locations.filter(location => location.estimatedHousingProfile)) {
    assert.ok(base.agents.some(agent => agent.home === location.id), `${location.id} has allocated residents`);
  }
  assert.ok(checkedTrips > 10000);
  // Walking speeds vary person to person (population.ts walkSpeedFor), and foot traffic spreads over near-equal routes.
  const speeds = [...speedOf.values()], mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  assert.ok(mean > 1.33 && mean < 1.41, `mean walking speed ${mean}`);
  assert.ok(new Set(speeds).size > 100 && Math.min(...speeds) < 1.25 && Math.max(...speeds) > 1.5);
  const share = alternativeTrips / directPairTrips;
  assert.ok(share > 0.1 && share < 0.6, `share of walks on a near-equal alternative route: ${share}`);
  console.log(`Verified ${checkedTrips} trips and 672 population snapshots across seven days`);
});
