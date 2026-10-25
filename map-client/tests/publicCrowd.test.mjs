import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const P = await import('../src/sim/publicCrowd.ts');
const O = await import('../src/data/observations.ts');

// ---- a tiny map: one street through a count site, one bus stop on another street
const SITE = [-71.1, 42.35];
const at = (east, north) => [SITE[0] + east / (111320 * Math.cos(SITE[1] * Math.PI / 180)), SITE[1] + north / 110540];
const line = (points) => {
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    cumulative.push(cumulative[i - 1] + Math.hypot((a[0] - b[0]) * 111320 * Math.cos(a[1] * Math.PI / 180), (a[1] - b[1]) * 110540));
  }
  return { path: points, cumulative };
};
const street = line([at(0, -300), at(0, -100), at(0, 0), at(0, 100), at(0, 300)]);
const stopStreet = line([at(500, 0), at(500, -200), at(500, -400)]);
const locations = [
  { id: 'dorm', name: 'Dorm', short: 'D', kind: 'dorm', position: at(0, -300), capacity: 100, building: 'b1' },
  { id: 'hall', name: 'Hall', short: 'H', kind: 'classroom', position: at(0, 300), capacity: 100, building: 'b2' },
  { id: 'lab', name: 'Lab', short: 'L', kind: 'classroom', position: at(500, -400), capacity: 100, building: 'b3' },
];
const hourBins = (values) => Object.entries(values).map(([h, value]) => ({ start: `${String(h).padStart(2, '0')}:00`, end: `${String(Number(h) + 1).padStart(2, '0')}:00`, value }));
const observations = (overrides = {}) => ({
  schemaVersion: 1, generatedAt: '', sources: [],
  transit: [{ id: 'bus-x-weekday-offs', kind: 'apc-alightings', mode: 'bus', stop: { name: 'X', mapStopId: 'X', mbtaStopIds: ['X'], position: at(500, 0) },
    route: '99', direction: 0, dayType: 'weekday', bins: hourBins({ 8: 10, 9: 4 }), unit: '', source: 's', expectedStudentShare: [0, 1], role: 'primary' }],
  pedestrian: [{ id: 'ped-site', site: 'Site', position: SITE, screen: { type: 'cordon', radiusMetres: 20 }, date: '2023-10-18', dayType: 'weekday',
    bins: hourBins({ 8: 30, 17: 50 }), unit: '', direction: null, source: 's', quality: 'primary', expectedStudentShare: [0, 1] }],
  ...overrides,
});
const studentTrip = (depart) => ({ agent: `s${depart}`, from: 'dorm', to: 'hall', path: street.path, timestamps: street.cumulative.map((m) => depart + m / 1.4) });
const day = {
  trips: [8.2, 8.4, 8.5, 8.6, 8.7].map((h) => studentTrip(h * 3600)),
  transitRides: [{ agent: 'r1', kind: 'alight', trip: 't', route: '99', direction: 0, stop: 'X', time: 8 * 3600 + 900, position: at(500, 0) },
    { agent: 'r2', kind: 'alight', trip: 't', route: '99', direction: 0, stop: 'X', time: 8 * 3600 + 900, position: at(500, 0) }],
  walkRoutes: { 'dorm>hall': street }, stopRoutes: { 'X>lab': stopStreet }, locations,
};
const sum = (values) => values.reduce((s, v) => s + v, 0);

test('public riders fill observed alightings less the simulated students, at the stop', () => {
  const crowd = P.buildPublicCrowd({ observations: observations(), day, weekday: 2 });
  const series = observations().transit[0];
  const students = O.simulatedTransit(day.transitRides, series), pub = crowd.transitCounts(series);
  assert.deepEqual(students, [2, 0]);
  assert.ok(Math.abs(sum(students) + sum(pub) - 14) <= 1, `total ${sum(students) + sum(pub)}`);
  pub.forEach((n, i) => assert.ok(Math.abs(students[i] + n - series.bins[i].value) <= 1.5, `bin ${i}`));
  for (const walk of crowd.walks.filter((w) => w.purpose === 'alight')) {
    assert.equal(walk.from, 0, 'riders step off at the stop end of the route');
    assert.ok(walk.to > 20);
  }
});

test('through walkers bring the count site to the observed total; hours without counts follow the activity curve', () => {
  const crowd = P.buildPublicCrowd({ observations: observations(), day, weekday: 2 });
  const site = observations().pedestrian[0];
  const students = O.simulatedPedestrians(day.trips, site), pub = crowd.pedestrianCounts(site);
  assert.deepEqual(students, [5, 0]);
  assert.ok(Math.abs(students[0] + pub[0] - 30) <= 1, `8 AM ${students[0] + pub[0]}`);
  assert.ok(Math.abs(pub[1] - 50) <= 1, `5 PM ${pub[1]}`);
  assert.ok(crowd.stats.through >= 70);
});

test('the crowd is deterministic, keeps its own ids, and never starts or ends at a university building', () => {
  const a = P.buildPublicCrowd({ observations: observations(), day, weekday: 2 });
  const b = P.buildPublicCrowd({ observations: observations(), day, weekday: 2 });
  assert.deepEqual(a.walks.map(({ route, ...w }) => w), b.walks.map(({ route, ...w }) => w));
  const metres = (p, q) => Math.hypot((p[0] - q[0]) * 111320 * Math.cos(p[1] * Math.PI / 180), (p[1] - q[1]) * 110540);
  const pointOn = (route, m) => {
    let i = 1; while (i < route.cumulative.length - 1 && route.cumulative[i] < m) i++;
    const f = (m - route.cumulative[i - 1]) / (route.cumulative[i] - route.cumulative[i - 1]);
    const [p, q] = [route.path[i - 1], route.path[i]];
    return [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f];
  };
  for (const walk of a.walks) {
    assert.ok(P.isPublicId(walk.id));
    for (const m of [walk.from, walk.to]) {
      if (walk.stop && m === (walk.purpose === 'alight' ? walk.from : walk.to)) continue; // the stop itself
      const p = pointOn(walk.route, m);
      for (const l of locations) assert.ok(metres(p, l.position) >= P.ENTRANCE_CLEAR_METRES - 0.5, `${walk.id} ends ${metres(p, l.position).toFixed(1)} m from ${l.id}`);
    }
  }
  for (const t of [8 * 3600 + 1800, 17 * 3600 + 1800]) {
    const walking = a.walkingAt(t);
    assert.equal(walking.length, a.countAt(t));
    assert.ok(walking.length > 0);
    assert.ok(walking.every((w) => P.isPublicId(w.id) && Number.isFinite(w.position[0]) && Number.isFinite(w.bearing)));
    assert.deepEqual(walking, b.walkingAt(t), 'same people in the same places at any playback speed');
  }
});

test('without observations there is no public crowd; extra sources count toward the fill only when the counts include them', () => {
  const empty = P.buildPublicCrowd({ observations: observations({ transit: [], pedestrian: [] }), day, weekday: 2 });
  assert.equal(empty.walks.length, 0);
  assert.equal(empty.walkingAt(9 * 3600).length, 0);
  const visitors = (counted) => ({ id: 'event', inObservedCounts: counted, pedestrians: (site) => site.bins.map(() => 10), transit: (s) => s.bins.map(() => 0) });
  const site = observations().pedestrian[0];
  const base = sum(P.buildPublicCrowd({ observations: observations(), day, weekday: 2 }).pedestrianCounts(site));
  const onTop = sum(P.buildPublicCrowd({ observations: observations(), day, weekday: 2, extraSources: [visitors(false)] }).pedestrianCounts(site));
  const inside = sum(P.buildPublicCrowd({ observations: observations(), day, weekday: 2, extraSources: [visitors(true)] }).pedestrianCounts(site));
  assert.equal(onTop, base, 'visitors not in the baseline are added on top by their own module');
  assert.ok(Math.abs(base - inside - 20) <= 2, `visitors inside the counts replace public walkers (${base} vs ${inside})`);
});

test('helpers: smoothing keeps totals, whole people track fractional totals, observed hours prefer the newest study', () => {
  assert.equal(sum(P.smooth([0, 10, 0, 4])), 14);
  assert.deepEqual(P.wholePeople([0.4, 0.4, 0.4, 1.8]), [0, 1, 0, 2]);
  const older = { id: 'old', date: '2018-04-12', bins: hourBins({ 8: 100, 12: 50 }) };
  const newer = { id: 'new', date: '2023-10-18', bins: hourBins({ 8: 80 }) };
  const hours = P.observedHours([older, newer]);
  assert.equal(hours.get(8).value, 80);
  assert.equal(hours.get(12).value, 50);
  const quarters = P.observedHours([{ id: 'q', date: '2020-01-01', bins: [0, 1, 2, 3].map((q) => ({ start: `07:${String(q * 15).padStart(2, '0')}`, end: q === 3 ? '08:00' : `07:${String(q * 15 + 15).padStart(2, '0')}`, value: q + 1 })) }]);
  assert.deepEqual(quarters.get(7).quarters, [1, 2, 3, 4]);
});

// ---- the bundled data: a full-roster Wednesday
const read = (name) => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url)));
const { buildPopulation } = await import('../src/sim/population.ts');
const { buildSourceDay } = await import('../src/sim/sourceDay.ts');
const { Playback } = await import('../src/sim/playback.ts');
const T = await import('../src/sim/transitService.ts');

test('bundled day: students are untouched, the public stays out of buildings, and everyone matches the counts', () => {
  const source = read('campus-data');
  const service = T.createTransitService(T.mergeSchedules(read('transit-schedule'), read('shuttle-schedule')));
  const base = buildPopulation(read('demo-day'), source, read('population'));
  const obs = read('calibration-observations');
  const wednesday = buildSourceDay(base, source, 2, service);
  const before = { agents: wednesday.agents.length, trips: wednesday.trips.length, stays: wednesday.stays.length, rides: wednesday.transitRides.length };
  const occupancy = new Playback(wednesday).occupancyAt(10 * 3600).map((o) => o.count);
  const crowd = P.buildPublicCrowd({ observations: obs, day: wednesday, weekday: 2, transit: service });
  assert.deepEqual({ agents: wednesday.agents.length, trips: wednesday.trips.length, stays: wednesday.stays.length, rides: wednesday.transitRides.length }, before);
  assert.deepEqual(new Playback(wednesday).occupancyAt(10 * 3600).map((o) => o.count), occupancy, 'building counts are students only');
  assert.ok(crowd.walks.length > 10000);
  const studentIds = new Set(wednesday.agents.map((a) => a.id));
  assert.ok(crowd.walks.every((w) => P.isPublicId(w.id) && !studentIds.has(w.id)));

  // Transit: where students do not already exceed the count, students + public = observed, bin by bin.
  let bins = 0, close = 0;
  for (const s of O.seriesForWeekday(obs, 2, { primaryOnly: true }).transit) {
    const students = O.simulatedTransit(wednesday.transitRides, s), pub = crowd.transitCounts(s);
    s.bins.forEach((b, i) => {
      if (students[i] > b.value) return;
      bins++;
      if (Math.abs(students[i] + pub[i] - b.value) <= Math.max(3, 0.1 * b.value)) close++;
    });
  }
  // 96%: the BU riders now include modeled staff, whose 08–09 and 17–18 commute peaks are sharper
  // than the 1-2-1 smoothing the public fill applies (src/sim/publicCrowd.ts) keeps bin-exact.
  assert.ok(close / bins > 0.96, `${close}/${bins} transit bins within tolerance`);
  // Pedestrians: the 2023 peak hours, where students alone are under the count.
  for (const s of obs.pedestrian.filter((p) => p.source === 'bu-warren-epnf-2024')) {
    const students = O.simulatedPedestrians(wednesday.trips, s), pub = crowd.pedestrianCounts(s);
    s.bins.forEach((b, i) => {
      if (students[i] >= b.value) return;
      const ratio = (students[i] + pub[i]) / b.value;
      assert.ok(ratio > 0.8 && ratio < 1.3, `${s.id} ${b.start}: ${ratio.toFixed(2)}`);
    });
  }
  const again = P.buildPublicCrowd({ observations: obs, day: wednesday, weekday: 2, transit: service });
  assert.deepEqual(again.stats, crowd.stats);
  assert.deepEqual(again.walkingAt(10 * 3600), crowd.walkingAt(10 * 3600));
});
