// The full campus week against each place's stated capacity: no place holds more people than its
// seats except retained classroom waits, small cafés and branch libraries don't absorb more demand
// per seat than the big halls, and a venue open only outside modeled visit times says so.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context); throw error; }
} });
const { buildPopulation } = await import('../src/sim/population.ts');
const { buildSourceDay, venueWeight, inModeledVisitTimes } = await import('../src/sim/sourceDay.ts');
const { expandDay, Playback } = await import('../src/sim/playback.ts');
const { conditionsFor } = await import('../src/sim/conditions.ts');
const { dateForWeekday } = await import('../src/data/campusData.ts');
const { createTransitService, mergeSchedules } = await import('../src/sim/transitService.ts');
const { sharedTagParts } = await import('../src/tags/names.ts');

const read = (name) => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url)));
const data = read('campus-data');
const base = buildPopulation(expandDay(read('demo-day')), data, read('population'));
const SMALL = 150; // the configured café and branch-library sizes are 30–150
const STEP = 300;

/** Per place: highest share and hours at 90% or more, sampled every five minutes. */
function scan(day) {
  const playback = new Playback(day);
  const out = new Map();
  for (let t = 0; t < 86400; t += STEP) {
    for (const o of playback.occupancyAt(t)) {
      if (o.location.kind === 'outdoor') continue;
      const row = out.get(o.location.id) ?? { location: o.location, peak: 0, peakCount: 0, fullHours: 0, visits: 0 };
      if (o.count > row.peakCount) { row.peakCount = o.count; row.peak = o.share; }
      if (o.share >= 0.9) row.fullHours += STEP / 3600;
      row.visits += o.count;
      out.set(o.location.id, row);
    }
  }
  return out;
}

const plainDays = Array.from({ length: 7 }, (_, weekday) => buildSourceDay(base, data, weekday, undefined, { eventDate: dateForWeekday(data, weekday) }));
const plainScans = plainDays.map(scan);

test('every place has a positive, finite capacity and the whole population is placed every day', () => {
  for (const location of base.locations) {
    if (location.kind === 'off-campus') continue;
    assert.ok(Number.isFinite(location.capacity) && location.capacity > 0, `${location.id} capacity ${location.capacity}`);
  }
  for (const day of plainDays) {
    assert.equal(day.agents.length, 36977 + 11140); // students, then modeled faculty and staff (sim/staff.ts)
    assert.equal(new Set(day.stays.map((stay) => stay.agent)).size, day.agents.length, day.day);
  }
});

test('no place, classroom buildings included, holds more people than its capacity in any hour of the week', () => {
  for (const [weekday, rows] of plainScans.entries()) {
    for (const row of rows.values()) {
      assert.ok(row.peakCount <= row.location.capacity, `${row.location.id} on weekday ${weekday}: ${row.peakCount} people, capacity ${row.location.capacity}`);
    }
  }
  for (const day of plainDays) for (const g of day.gatherings) assert.ok(g.attendees <= g.capacity, `${g.id} ${g.attendees}/${g.capacity}`);
});

test('a small café or branch library is not full for longer than the big venues of its kind', () => {
  for (const [weekday, rows] of plainScans.entries()) {
    for (const kind of ['dining', 'library']) {
      const venues = [...rows.values()].filter((row) => row.location.kind === kind);
      const bigFull = Math.max(0, ...venues.filter((row) => row.location.capacity > SMALL).map((row) => row.fullHours));
      for (const row of venues.filter((r) => r.location.capacity <= SMALL)) {
        assert.ok(row.fullHours <= bigFull + 1, `${row.location.id} weekday ${weekday}: ${row.fullHours.toFixed(1)} h at 90%+, big ${kind} venues at most ${bigFull.toFixed(1)} h`);
      }
    }
  }
  // At equal travel, every seat draws the same demand.
  assert.equal(venueWeight(40, 600) * 800, venueWeight(800, 600) * 40);
});

test('seven conditioned days have complete itineraries and no seated or optional capacity violations', () => {
  const transit = createTransitService(mergeSchedules(read('transit-schedule'), read('shuttle-schedule')));
  const model = { behavior: read('behavior'), personas: read('personas'), outdoor: read('outdoor') };
  for (let weekday = 0; weekday < 7; weekday++) {
    const date = dateForWeekday(data, weekday);
    const conditions = conditionsFor({ date, weekday, calendar: data.academicCalendar, weather: null });
    const day = buildSourceDay(base, data, weekday, transit, { eventDate: date, conditions, model });
    const capacity = new Map(day.locations.map((location) => [location.id, location]));
    assert.equal(day.agents.length, 36977 + 11140); // students, then modeled faculty and staff (sim/staff.ts)
    const parts = new Map(day.agents.map(agent => [agent.id, []]));
    const events = new Map();
    for (const stay of day.stays) {
      parts.get(stay.agent).push({start: stay.start, end: stay.end, from: stay.location, to: stay.location});
      const location = capacity.get(stay.location);
      if (!location || ['off-campus', 'outdoor'].includes(location.kind)) continue;
      const rows = events.get(location.id) ?? [];
      const seated = stay.purpose?.kind === 'wait' ? 0 : 1;
      rows.push([stay.start, 1, seated], [stay.end, -1, -seated]);
      events.set(location.id, rows);
    }
    for (const trip of day.trips) {
      assert.equal(trip.path.length, trip.timestamps.length);
      assert.ok(trip.timestamps.every(Number.isFinite));
      for (let i = 1; i < trip.timestamps.length; i++) assert.ok(trip.timestamps[i] >= trip.timestamps[i - 1]);
      parts.get(trip.agent).push({start: trip.timestamps[0], end: trip.timestamps.at(-1), from: trip.from, to: trip.to});
    }
    for (const [id, rows] of parts) {
      rows.sort((a, b) => a.start - b.start || a.end - b.end);
      assert.equal(rows[0].start, 0, id);
      assert.equal(rows.at(-1).end, 86400, id);
      for (let i = 1; i < rows.length; i++) {
        assert.ok(Math.abs(rows[i].start - rows[i - 1].end) < 1e-7, `${id}: gap or overlap`);
        if (rows[i].from !== rows[i - 1].to) {
          const from = capacity.get(rows[i - 1].to), to = capacity.get(rows[i].from);
          const route = day.walkRoutes?.[`${from.id}>${to.id}`];
          assert.ok(route?.cumulative.at(-1) === 0 || Math.hypot((from.position[0] - to.position[0]) * 82400,
            (from.position[1] - to.position[1]) * 110540) <= 1, `${id}: transition without walking`);
        }
      }
    }
    const over = [];
    for (const [id, rows] of events) {
      const location = capacity.get(id);
      assert.equal(location.capacity, base.locations.find(row => row.id === id).capacity);
      rows.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let everyone = 0, seated = 0, peak = 0;
      for (const [, delta, seatedDelta] of rows) {
        everyone += delta; seated += seatedDelta; peak = Math.max(peak, everyone);
        assert.ok(seated <= location.capacity, `${day.day} ${id}: ${seated} seated / ${location.capacity}`);
        if (location.kind !== 'classroom') assert.ok(everyone <= location.capacity,
          `${day.day} ${id}: ${everyone} present / ${location.capacity}`);
      }
      if (peak > location.capacity) over.push(`${id} ${peak}/${location.capacity}`);
    }
    for (const g of day.gatherings) assert.ok(g.attendees <= g.capacity);
    console.log(`${day.day}: ${day.agents.length} complete itineraries (staff on site: ${day.sourceStats.staff.onSite}); retained classroom wait peaks: ${over.join(', ') || 'none'}; waits shortened: ${day.sourceStats.classroomWaitsShortened}`);
  }
});

test('After Hours, a late-night counter, is left off the map: no place, tag, visit or walk', () => {
  for (const day of plainDays) {
    assert.ok(!day.locations.some((location) => location.id === 'after-hours-west'), day.day);
    assert.ok(!day.stays.some((stay) => stay.location === 'after-hours-west'), day.day);
    assert.ok(!day.trips.some((trip) => trip.from === 'after-hours-west' || trip.to === 'after-hours-west'), day.day);
    assert.ok(!new Playback(day).occupancyAt(23 * 3600).some((row) => row.location.id === 'after-hours-west'), day.day);
  }
  // A venue open only after modeled dinners end would not be modeled; Friday's 21:30 opening would be.
  assert.equal(inModeledVisitTimes('dining', [[22.5 * 3600, 25 * 3600]], 0), false);
  assert.equal(inModeledVisitTimes('dining', [[21.5 * 3600, 25 * 3600]], 4), true);
});

test('a building holding only libraries is tagged for its own library, with dots for the others', () => {
  const places = (building) => base.locations.filter((location) => location.building === building).map((location) => ({ location }));
  const mugar = base.locations.find((location) => location.id === 'mugar');
  const parts = sharedTagParts(places(mugar.building));
  assert.deepEqual(parts.rest.map((o) => o.location.id), ['mugar']);
  assert.deepEqual(sharedTagParts(places(mugar.building).reverse()).rest.map(o => o.location.id), ['mugar']);
  assert.deepEqual(parts.amenities.map((o) => o.location.id).sort(), ['african-studies-library', 'music-library']);
  const questrom = sharedTagParts(places(base.locations.find((location) => location.id === 'questrom').building));
  assert.deepEqual(questrom.rest.map((o) => o.location.id), ['questrom']);
  assert.deepEqual(sharedTagParts([{ location: mugar }]), { rest: [], amenities: [{ location: mugar }] });
});
