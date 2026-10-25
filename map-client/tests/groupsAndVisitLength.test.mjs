// Skewed visit lengths (sim/visitLength.ts) and friends eating together (sim/groups.ts): visits
// last a stable lognormal length around the menu mean; a share of campus meals are taken by 2–4
// dorm-mates or classmates who share venue, start and end, walk together and are drawn side by side.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context); throw error; }
} });
const { buildSourceDay, freeTimeActivities, LEGACY_BEHAVIOR } = await import('../src/sim/sourceDay.ts');
const { Playback, expandDay } = await import('../src/sim/playback.ts');
const { normalFrom, visitLengthFactor, VISIT_LENGTH_SIGMA, VISIT_LENGTH_BOUNDS } = await import('../src/sim/visitLength.ts');
const { abreastOffset, mealGroupSize, MAX_ABREAST, WALK_ABREAST_SPACING_METRES } = await import('../src/sim/groups.ts');
const { buildPopulation } = await import('../src/sim/population.ts');
const { dateForWeekday } = await import('../src/data/campusData.ts');
const { conditionsFor } = await import('../src/sim/conditions.ts');

const metres = (a, b) => Math.hypot((a[0] - b[0]) * 111320 * Math.cos(a[1] * Math.PI / 180), (a[1] - b[1]) * 111320);
/** Deterministic uniform draws (FNV-1a + avalanche), as the simulator hashes. */
function u(key) {
  let value = 2166136261;
  for (let index = 0; index < key.length; index++) value = Math.imul(value ^ key.charCodeAt(index), 16777619);
  value ^= value >>> 16; value = Math.imul(value, 0x85ebca6b); value ^= value >>> 13; value = Math.imul(value, 0xc2b2ae35); value ^= value >>> 16;
  return (value >>> 0) / 4294967296;
}
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

test('visit lengths are skewed and mean-preserving: most a little shorter than the mean, a long tail', () => {
  const factors = Array.from({ length: 40000 }, (_, i) => visitLengthFactor(
    normalFrom(u(`p${i % 400}:1`), u(`p${i % 400}:2`)), normalFrom(u(`v${i}:1`), u(`v${i}:2`)), VISIT_LENGTH_SIGMA)).sort((a, b) => a - b);
  const mean = factors.reduce((sum, x) => sum + x, 0) / factors.length;
  assert.ok(Math.abs(mean - 1) < 0.03, `mean ${mean}`);
  assert.ok(quantile(factors, 0.5) < 0.95 && quantile(factors, 0.5) > 0.85, `median ${quantile(factors, 0.5)}`);
  assert.ok(factors.filter(x => x < 1).length / factors.length > 0.55, 'most visits are shorter than the mean');
  assert.ok(quantile(factors, 0.9) > 1.45, `p90 ${quantile(factors, 0.9)}`);
  assert.ok(factors[0] >= VISIT_LENGTH_BOUNDS[0] && factors.at(-1) <= VISIT_LENGTH_BOUNDS[1]);
  // Stable: the same draws give the same length; no spread means the menu's exact minutes.
  assert.equal(visitLengthFactor(0.3, -1.2, 0.45), visitLengthFactor(0.3, -1.2, 0.45));
  assert.equal(visitLengthFactor(2, 2, 0), 1);
  // The plain day and the conditions engine use the same distribution and width.
  assert.equal(LEGACY_BEHAVIOR.scalars.visitLengthSpread, VISIT_LENGTH_SIGMA);
  const behavior = JSON.parse(readFileSync(new URL('../public/data/behavior.json', import.meta.url)));
  assert.equal(behavior.scalars.visitLengthSpread.base, VISIT_LENGTH_SIGMA);
});

function location(id, kind, position, capacity = 100) {
  return { id, name: id, short: id, kind, position, capacity, building: id, campus: 'main' };
}
/** One dorm, a classroom, a small dining hall, a library and a gym, all 140 m apart. */
function fixture({ residents = 160, mealSeats = 16 } = {}) {
  const locations = [location('home', 'dorm', [-71.1, 42.35], 400), location('class', 'classroom', [-71.101, 42.35]),
    location('meal', 'dining', [-71.102, 42.35], mealSeats), location('study', 'library', [-71.103, 42.35]), location('gym', 'gym', [-71.104, 42.35])];
  const walkRoutes = {};
  for (const from of locations) for (const to of locations) if (from.id !== to.id) walkRoutes[`${from.id}>${to.id}`] = { path: [from.position, to.position], cumulative: [0, 140] };
  const base = { day: 'Wednesday', locations, buildings: [], walkRoutes, trips: [], stopRoutes: {},
    agents: Array.from({ length: residents }, (_, i) => ({ id: `r${i}`, home: 'home', residency: 'resident', campus: 'main', model: i % 12 })) };
  const data = { schemaVersion: 1, term: 'FALL 2026', collectedAt: '2026-10-24', referenceWeekStart: '2026-10-19', coverage: {}, locations: {}, events: [], libraryHistory: {}, signals: [], assumptions: [], inputFiles: [] };
  for (const loc of locations) data.locations[loc.id] = { id: loc.id, buildingCodes: [], meetings: [], evidence: [],
    hours: ['dining', 'library', 'gym'].includes(loc.kind) ? Array.from({ length: 7 }, (_, weekday) => ({ date: null, weekday, windows: [[7 * 3600, 23 * 3600]], text: 'Published weekly schedule', sourceUrl: 'source', qualifier: null })) : [] };
  return { base, data };
}
/** Every student's day is complete: stays and walks cover 00:00–24:00 without gaps or overlaps. */
function validate(day) {
  const parts = new Map(day.agents.map(a => [a.id, []]));
  for (const stay of day.stays) parts.get(stay.agent).push([stay.start, stay.end]);
  for (const trip of day.trips) parts.get(trip.agent).push([trip.timestamps[0], trip.timestamps.at(-1)]);
  for (const [agent, list] of parts) {
    list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    assert.equal(list[0][0], 0, agent); assert.equal(list.at(-1)[1], 86400, agent);
    for (let i = 1; i < list.length; i++) assert.ok(Math.abs(list[i][0] - list[i - 1][1]) < 1e-6, `${agent}: gap or overlap at ${list[i][0]}`);
  }
}
const groupsOf = (day) => {
  const groups = new Map();
  for (const activity of day.sourceActivities) if (activity.group) groups.set(activity.group, [...(groups.get(activity.group) ?? []), activity]);
  return groups;
};

test('a plain day draws varied visit lengths around each menu mean', () => {
  const { base, data } = fixture({ mealSeats: 400 });
  const day = buildSourceDay(base, data, 2);
  const menu = freeTimeActivities(2);
  for (const kind of ['dining', 'library']) {
    const lengths = day.sourceActivities.filter(a => a.kind === kind).map(a => (a.endSec - a.startSec) / 60).sort((a, b) => a - b);
    assert.ok(lengths.length > 40, kind);
    assert.ok(new Set(lengths.map(x => x.toFixed(3))).size > lengths.length / 3, `${kind} lengths vary`);
    const means = menu.filter(a => a.kind === kind).map(a => a.minutes);
    assert.ok(lengths[0] >= Math.min(...means) * VISIT_LENGTH_BOUNDS[0] - 1e-6 && lengths.at(-1) <= Math.max(...means) * VISIT_LENGTH_BOUNDS[1] + 1e-6, kind);
    const mean = lengths.reduce((sum, x) => sum + x, 0) / lengths.length;
    assert.ok(mean > Math.min(...means) * 0.75 && mean < Math.max(...means) * 1.2, `${kind} mean ${mean}`);
  }
});

test('friends share a meal: same venue, start and end, 2–4 at a table, walking together, within seats', () => {
  const { base, data } = fixture();
  const day = buildSourceDay(base, data, 2);
  const again = buildSourceDay(fixture().base, fixture().data, 2);
  assert.deepEqual(day.sourceActivities.map(a => a.group ?? ''), again.sourceActivities.map(a => a.group ?? ''), 'deterministic');
  const meals = day.sourceActivities.filter(a => a.kind === 'dining');
  const groups = groupsOf(day);
  assert.ok(groups.size >= 5, `groups: ${groups.size}`);
  const share = [...groups.values()].reduce((sum, g) => sum + g.length, 0) / meals.length;
  assert.ok(share > 0.1 && share < 0.5, `share ${share}`);
  let walkedTogether = 0;
  for (const members of groups.values()) {
    assert.ok(members.length >= 2 && members.length <= 4, `size ${members.length}`);
    assert.equal(new Set(members.map(m => m.agentId)).size, members.length);
    for (const member of members) {
      assert.equal(member.groupSize, members.length);
      assert.equal(member.locationId, members[0].locationId);
      assert.equal(member.startSec, members[0].startSec);
      assert.equal(member.endSec, members[0].endSec);
    }
    // Dorm-mates coming from the dorm walk the same route at the same moment, arriving as the meal starts.
    const arrivals = members.map(m => day.trips.find(t => t.agent === m.agentId && t.to === m.locationId && Math.abs(t.timestamps.at(-1) - m.startSec) < 1e-6))
      .filter(t => t && t.from === 'home');
    if (arrivals.length >= 2 && arrivals.every(t => t.timestamps.every((time, k) => Math.abs(time - arrivals[0].timestamps[k]) < 1e-6))) walkedTogether++;
  }
  assert.ok(walkedTogether >= groups.size / 3, `${walkedTogether} of ${groups.size} groups walked over together`);
  // Seats are respected with groups: the 16-seat hall fills but is never over capacity.
  const playback = new Playback(day);
  let peak = 0;
  for (let t = 0; t < 86400; t += 60) {
    const meal = playback.occupancyAt(t).find(o => o.location.id === 'meal');
    assert.ok(!meal || meal.count <= 16, `${meal?.count} at ${t}`);
    peak = Math.max(peak, meal?.count ?? 0);
  }
  assert.equal(peak, 16, 'the hall does fill');
  validate(day);
});

test('people setting off together are drawn side by side, about 0.9 m apart, centred on the route', () => {
  const a = [-71.1, 42.35], b = [-71.098, 42.35];
  const trip = (agent, depart) => ({ agent, from: 'x', to: 'y', path: [a, b], timestamps: [depart, depart + 120] });
  const day = { day: 'Wednesday', buildings: [], agents: ['p', 'q', 'r', 's'].map((id, model) => ({ id, home: 'x', model })),
    locations: [location('x', 'dorm', a), location('y', 'dining', b)], trips: [trip('p', 100), trip('q', 100), trip('r', 100), trip('s', 400)], stays: [] };
  const playback = new Playback(day);
  const walkers = new Map(playback.walkingAt(160).map(w => [w.id, w.position]));
  assert.equal(walkers.size, 3);
  const [p, q, r] = ['p', 'q', 'r'].map(id => walkers.get(id));
  for (const [x, y] of [[p, q], [q, r]]) assert.ok(Math.abs(metres(x, y) - WALK_ABREAST_SPACING_METRES) < 0.01, `${metres(x, y)}`);
  assert.ok(metres(p, r) > 1.7);
  // Centred: the middle one is on the route line; all are equally far along it (heading east, offsets are north–south).
  assert.ok(Math.abs(q[1] - a[1]) * 111320 < 0.01 && Math.abs(p[0] - q[0]) < 1e-9 && Math.abs(r[0] - q[0]) < 1e-9);
  // Someone walking alone stays on the line.
  const alone = playback.walkingAt(460).find(w => w.id === 's');
  assert.ok(Math.abs(alone.position[1] - a[1]) < 1e-12);
  assert.equal(abreastOffset(0, 1), 0);
  assert.ok(MAX_ABREAST === 4 && [2, 3, 4].includes(mealGroupSize(0.99)) && mealGroupSize(0) === 2);
});

test('on the full campus, about a quarter of meals are shared and companions do not overlap on screen', () => {
  const read = (name) => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url)));
  const data = read('campus-data');
  const base = buildPopulation(expandDay(read('demo-day')), data, read('population'));
  const day = buildSourceDay(base, data, 2, undefined, { eventDate: dateForWeekday(data, 2) });
  const meals = day.sourceActivities.filter(a => a.kind === 'dining');
  const groups = groupsOf(day);
  const share = [...groups.values()].reduce((sum, g) => sum + g.length, 0) / meals.length;
  assert.ok(share >= 0.18 && share <= 0.32, `share ${share}`);
  const capacity = new Map(day.locations.map(l => [l.id, l.capacity]));
  for (const members of groups.values()) {
    assert.ok(members.length >= 2 && members.length <= 4);
    assert.ok(members.every(m => m.locationId === members[0].locationId && m.startSec === members[0].startSec && m.endSec === members[0].endSec));
    assert.ok(members.length <= capacity.get(members[0].locationId));
  }
  // Companions leaving the meal on the same walk (no bigger crowd at that door that second) are ≥ 0.8 m apart.
  const tripsOf = new Map();
  for (const trip of day.trips) tripsOf.set(trip.agent, [...(tripsOf.get(trip.agent) ?? []), trip]);
  const departures = new Map();
  for (const trip of day.trips) { const key = `${trip.from}|${Math.round(trip.timestamps[0] * 100)}`; departures.set(key, (departures.get(key) ?? 0) + 1); }
  const playback = new Playback(day);
  let checked = 0;
  for (const members of [...groups.values()].slice(0, 400)) {
    // Only companions walking the same way: friends heading to different places split at the door.
    const all = members.map(m => tripsOf.get(m.agentId)?.find(t => t.from === m.locationId && Math.abs(t.timestamps[0] - m.endSec) < 1e-6)).filter(Boolean);
    const leaving = all.filter(trip => trip.to === all[0].to);
    if (leaving.length < 2 || departures.get(`${leaving[0].from}|${Math.round(leaving[0].timestamps[0] * 100)}`) > MAX_ABREAST) continue;
    const t = leaving[0].timestamps[0] + 20;
    const positions = new Map(playback.walkingAt(t).map(w => [w.id, w.position]));
    const shown = leaving.filter(trip => trip.timestamps.at(-1) > t).map(trip => positions.get(trip.agent)).filter(Boolean);
    for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) { assert.ok(metres(shown[i], shown[j]) >= 0.8, `${metres(shown[i], shown[j])} m`); checked++; }
  }
  assert.ok(checked > 50, `checked ${checked}`);

  // Under the conditions engine walking speeds differ, so companions keep to one pace: dorm-mates and
  // classmates setting off from the same place reach the meal on identical timings.
  const model = { behavior: read('behavior'), personas: read('personas'), outdoor: read('outdoor') };
  const conditions = conditionsFor({ date: dateForWeekday(data, 2), weekday: 2, calendar: data.academicCalendar, weather: { condition: 'clear', temperatureF: 62 } });
  const tuned = buildSourceDay(base, data, 2, undefined, { eventDate: dateForWeekday(data, 2), conditions, model });
  const tunedGroups = groupsOf(tuned);
  const tunedShare = [...tunedGroups.values()].reduce((sum, g) => sum + g.length, 0) / tuned.sourceActivities.filter(a => a.kind === 'dining').length;
  assert.ok(tunedShare >= 0.15 && tunedShare <= 0.32, `conditioned share ${tunedShare}`);
  const tunedTrips = new Map();
  for (const trip of tuned.trips) tunedTrips.set(trip.agent, [...(tunedTrips.get(trip.agent) ?? []), trip]);
  let together = 0;
  for (const members of tunedGroups.values()) {
    const arrivals = members.map(m => tunedTrips.get(m.agentId)?.find(t => t.to === m.locationId && Math.abs(t.timestamps.at(-1) - m.startSec) < 1e-6)).filter(Boolean);
    const starts = new Map();
    for (const trip of arrivals) starts.set(`${trip.from}|${trip.timestamps[0].toFixed(3)}`, (starts.get(`${trip.from}|${trip.timestamps[0].toFixed(3)}`) ?? 0) + 1);
    if ([...starts.values()].some(count => count > 1)) together++;
  }
  assert.ok(together > tunedGroups.size * 0.4, `${together} of ${tunedGroups.size} conditioned groups walked over together`);
});
