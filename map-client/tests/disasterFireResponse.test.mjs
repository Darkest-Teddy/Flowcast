import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context); throw error; }
} });
const { buildFireResponse, planFireResponse, fireResponseAt, FIRE_RESPONSE_ASSUMPTIONS: A, FIRE_RESPONSE_LIMITATIONS } = await import('../src/sim/disasterFireResponse.ts');
const { footprintDistance } = await import('../src/sim/disasters.ts');

// Straight eastbound bus street along latitude 42 from -71.01 to -70.99 (≈ 1655 m). The target
// building A sits just north of it around -71. 0.0001° lat ≈ 11.1 m, 0.0001° lng ≈ 8.3 m.
const KY = 111320, KX = KY * Math.cos(42 * Math.PI / 180);
const box = (id, x0, y0, x1, y1, height = 20) => ({ id, name: id, polygon: [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]], height });
const A_BOX = box('A', -71.0001, 42.0002, -70.9999, 42.0004, 30);
const street = (kind = 'bus', path = [[-71.01, 42], [-70.99, 42]], extra = {}) => ({ id: `r-${kind}`, name: kind, longName: kind, kind, color: '#000', textColor: '#fff', directions: ['E', 'W'], paths: [{ direction: 0, path, ...extra }] });
const run = (extra = {}) => ({ incident: { kind: 'fire', start: 36000 }, location: { position: [-71, 42.0003], building: 'A' }, hazard: { activeUntil: 37800 }, ...extra });
const metres = (a, b) => Math.hypot((a[0] - b[0]) * KX, (a[1] - b[1]) * KY);
function toPolyline(p, path) { // metres from p to a [lng, lat] polyline
  let best = Infinity;
  for (let i = 1; i < path.length; i++) {
    const ax = (path[i - 1][0] - p[0]) * KX, ay = (path[i - 1][1] - p[1]) * KY, bx = (path[i][0] - p[0]) * KX, by = (path[i][1] - p[1]) * KY;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy, t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}
const inside = (p, polygon) => footprintDistance(p, polygon) === 0;
/** Seven body points of a parked/driving truck: centre, front/rear, four corners. */
function body(frame) {
  const r = frame.bearing * Math.PI / 180, ux = Math.sin(r), uy = Math.cos(r), hl = A.truckHalfLengthMetres, hw = A.truckWidthMetres / 2;
  const at = (a, b) => [frame.position[0] + (ux * a + uy * b) / KX, frame.position[1] + (uy * a - ux * b) / KY];
  return [at(0, 0), at(hl, 0), at(-hl, 0), at(hl, hw), at(hl, -hw), at(-hl, hw), at(-hl, -hw)];
}
const sweep = (plan, step = 1) => {
  const t0 = Math.min(...plan.trucks.map(t => t.departAt)) - 5, t1 = Math.max(...plan.trucks.map(t => t.exitAt)) + 5, out = [];
  for (let t = t0; t <= t1; t += step) out.push([t, fireResponseAt(plan, t)]);
  return out;
};
const freeze = v => { if (v && typeof v === 'object') { Object.freeze(v); for (const c of Object.values(v)) freeze(c); } return v; };

test('assumptions and limitations are stated', () => {
  assert.equal(A.trucks, 2); assert.equal(A.dispatchDelaySeconds, 60); assert.equal(A.staggerSeconds, 20); assert.equal(A.maxHoseMetres, 80);
  assert.ok(A.cruiseSpeed > 0 && A.cruiseSpeed <= 12);
  assert.ok(FIRE_RESPONSE_LIMITATIONS.some(s => /illustrative/i.test(s) && /no real fire station/i.test(s)));
  assert.ok(FIRE_RESPONSE_LIMITATIONS.some(s => /visual cue only/i.test(s)));
});

test('non-fire incidents and fires without an active window get no trucks', () => {
  for (const kind of ['fire-drill', 'building-closure', 'earthquake', 'meteor'])
    assert.deepEqual(planFireResponse(run({ incident: { kind, start: 36000 } }), { routes: [street()] }, [A_BOX]), { plan: null, reason: 'not-fire' });
  assert.equal(planFireResponse(run({ hazard: undefined }), { routes: [street()] }, [A_BOX]).reason, 'no-active-fire');
  assert.equal(planFireResponse(run({ hazard: { activeUntil: 36000 } }), { routes: [street()] }, [A_BOX]).reason, 'no-active-fire');
  assert.deepEqual(fireResponseAt(null, 36500), []);
});

test('missing, subway-only or distant corridors return null with a reason', () => {
  assert.equal(planFireResponse(run(), { routes: [] }, [A_BOX]).reason, 'no-corridor');
  assert.equal(planFireResponse(run(), { routes: [street('subway')] }, [A_BOX]).reason, 'no-corridor');
  assert.equal(buildFireResponse(run(), { routes: [street('subway')] }, [A_BOX]), null);
  assert.equal(planFireResponse(run(), { routes: [street('bus', [[-71.01, 42.002], [-70.99, 42.002]])] }, [A_BOX]).reason, 'out-of-reach');
  assert.ok(buildFireResponse(run(), { routes: [street('subway'), street('shuttle')] }, [A_BOX]).routeId === 'r-shuttle');
});

test('a facade screened by a neighbouring building is obstructed, never sprayed through', () => {
  const wall = box('W', -71.003, 42.0001, -70.997, 42.00015, 10);
  const r = planFireResponse(run(), { routes: [street()] }, [A_BOX, wall]);
  assert.deepEqual(r, { plan: null, reason: 'obstructed' });
  // A partial screen: trucks park where the straight hose line misses it.
  const shed = box('S', -71.0002, 42.0001, -70.9998, 42.00015, 4);
  const plan = buildFireResponse(run(), { routes: [street()] }, [A_BOX, shed]);
  assert.ok(plan);
  for (const truck of plan.trucks) {
    const [, frames] = [0, fireResponseAt(plan, truck.fightStart + 1)];
    const f = frames.find(x => x.id === truck.id);
    for (let i = 1; i < 50; i++) {
      const t = i / 50, p = [f.position[0] + (f.waterTarget[0] - f.position[0]) * t, f.position[1] + (f.waterTarget[1] - f.position[1]) * t];
      assert.ok(!inside(p, shed.polygon), `${truck.id} hose crosses the shed`);
    }
  }
});

test('trucks park at distinct spots, clear of every footprint including the truck corners', () => {
  // A kiosk on the south kerb right where the nearest spot would be: centre line clear, corners not.
  const lane = -A.laneOffsetMetres / KY;
  const kiosk = box('K', -71.0003, 42 + lane - 5 / KY, -70.9997, 42 + lane - 0.9 / KY, 3);
  const footprints = [A_BOX, kiosk];
  const plan = buildFireResponse(run(), { routes: [street()] }, footprints);
  assert.equal(plan.trucks.length, 2);
  const parked = fireResponseAt(plan, plan.trucks[1].fightStart + 10);
  assert.equal(parked.length, 2);
  assert.ok(metres(parked[0].position, parked[1].position) >= A.minSpacingMetres - 0.5);
  assert.ok(metres(parked[0].position, parked[1].position) <= A.maxSpacingMetres + 0.5);
  for (const f of parked) {
    for (const p of body(f)) for (const fp of footprints) assert.ok(!inside(p, fp.polygon), `${f.id} body point inside ${fp.id}`);
    assert.equal(f.phase, 'fighting'); assert.equal(f.speed, 0);
    assert.ok(metres(f.position, f.waterTarget) <= A.maxHoseMetres);
    assert.ok(footprintDistance(f.waterTarget, A_BOX.polygon) < 0.5, 'water target on the facade');
    assert.ok(f.waterTarget[2] >= A.minWaterHeight && f.waterTarget[2] <= A.maxWaterHeight);
  }
  // Without the kiosk the trucks would have parked where its corners are.
  const free = fireResponseAt(buildFireResponse(run(), { routes: [street()] }, [A_BOX]), 37000);
  assert.ok(free.some(f => body(f).some(p => inside(p, kiosk.polygon))), 'fixture exercises the corner check');
});

test('dispatch, stagger and phase boundaries; no early arrival or early water', () => {
  const plan = buildFireResponse(run(), { routes: [street()] }, [A_BOX]);
  const [one, two] = plan.trucks;
  assert.equal(one.id, 'engine-1'); assert.equal(two.id, 'engine-2');
  assert.equal(one.departAt, 36000 + 60); assert.equal(two.departAt, 36000 + 80);
  assert.equal(two.leaveAt - one.leaveAt, 20);
  for (const t of plan.trucks) {
    assert.ok(t.departAt < t.arriveAt && t.arriveAt < t.fightStart && t.fightStart < t.fightEnd && t.fightEnd < t.leaveAt && t.leaveAt < t.exitAt);
    assert.equal(t.fightStart - t.arriveAt, A.setupSeconds); assert.equal(t.fightEnd, 37800);
    const at = time => fireResponseAt(plan, time).find(f => f.id === t.id);
    assert.equal(at(t.departAt - 0.01), undefined);
    assert.equal(at(t.departAt).phase, 'responding');
    assert.equal(at(t.arriveAt - 0.01).phase, 'responding');
    assert.equal(at(t.arriveAt).phase, 'staging');
    assert.equal(at(t.fightStart - 0.01).phase, 'staging'); assert.equal(at(t.fightStart - 0.01).waterTarget, undefined);
    assert.equal(at(t.fightStart).phase, 'fighting'); assert.ok(at(t.fightStart).waterTarget);
    assert.equal(at(t.fightEnd).phase, 'staging'); assert.equal(at(t.fightEnd).waterTarget, undefined);
    assert.equal(at(t.leaveAt).phase, 'leaving');
    assert.equal(at(t.exitAt), undefined);
  }
  for (const [time, frames] of sweep(plan, 0.5)) for (const f of frames) if (f.phase === 'fighting') assert.ok(time >= 36000 + 60 && time < 37800);
  assert.deepEqual(fireResponseAt(plan, 35999), []);
  // A fire that ends before setup finishes never shows water.
  const short = buildFireResponse(run({ hazard: { activeUntil: 36100 } }), { routes: [street()] }, [A_BOX]);
  assert.ok(sweep(short).every(([, frames]) => frames.every(f => f.phase !== 'fighting' && !f.waterTarget)));
});

test('trucks stay on the saved corridor, face travel, brake smoothly and never jump or reverse', () => {
  const plan = buildFireResponse(run(), { routes: [street()] }, [A_BOX]);
  const centre = street().paths[0].path;
  const last = new Map();
  for (const [time, frames] of sweep(plan, 0.5)) {
    for (const f of frames) {
      assert.ok(toPolyline(f.position, centre) <= A.laneOffsetMetres + 0.2, 'on the road');
      assert.ok(Math.abs(f.bearing - 90) < 0.5, `eastbound bearing ${f.bearing}`);
      assert.ok(f.speed >= 0 && f.speed <= A.cruiseSpeed + 1e-9);
      const prev = last.get(f.id);
      if (prev) {
        const dx = (f.position[0] - prev.f.position[0]) * KX;
        assert.ok(dx >= -1e-3, `${f.id} reversed at ${time}`);
        assert.ok(metres(f.position, prev.f.position) <= A.cruiseSpeed * (time - prev.time) + 0.05, `${f.id} jumped at ${time}`);
        if (f.phase === 'responding' && prev.f.phase === 'responding' && f.speed < A.cruiseSpeed) assert.ok(f.speed <= prev.f.speed + 1e-9, 'decelerating');
      }
      last.set(f.id, { f, time });
    }
  }
  // Approach is about 600 m and bounded by the path start when the fire is near it.
  for (const t of plan.trucks) assert.ok(Math.abs(t.stageAt - A.approachMetres) < 1);
  const nearStart = buildFireResponse(run({ location: { position: [-71.0097, 42.0003], building: 'A2' } }), { routes: [street()] },
    [box('A2', -71.0098, 42.0002, -71.0096, 42.0004)]);
  for (const t of nearStart.trucks) {
    assert.ok(t.stageAt < 100);
    assert.deepEqual(fireResponseAt(nearStart, t.departAt).find(f => f.id === t.id).position, t.path[0]);
    assert.ok(metres(t.path[0], [-71.01, 42 - A.laneOffsetMetres / KY]) < 0.5, 'enters at the saved path start');
  }
});

test('seeking is stateless: any order, repeated builds and frozen inputs give identical frames', () => {
  const inputs = freeze({ run: run(), transit: { routes: [street()] }, footprints: [A_BOX] });
  const plan = buildFireResponse(inputs.run, inputs.transit, inputs.footprints);
  assert.deepEqual(buildFireResponse(inputs.run, inputs.transit, inputs.footprints), plan);
  const times = sweep(plan, 7).map(([t]) => t);
  const forward = times.map(t => fireResponseAt(plan, t));
  const shuffled = [...times].reverse().map(t => [t, fireResponseAt(plan, t)]).reverse().map(([, f]) => f);
  assert.deepEqual(shuffled, forward);
  assert.deepEqual(fireResponseAt(plan, 37000), fireResponseAt(plan, 37000));
  const frames = fireResponseAt(plan, 37000); frames[0].position[0] = 0;
  assert.notEqual(fireResponseAt(plan, 37000)[0].position[0], 0, 'frames do not alias the plan');
});

test('real CDS fixture: trucks use a saved bus corridor and stay on it', () => {
  const day = JSON.parse(readFileSync(new URL('../public/data/demo-day.json', import.meta.url)));
  const transit = JSON.parse(readFileSync(new URL('../public/data/transit.json', import.meta.url)));
  const cds = day.locations.find(l => l.id === 'cds');
  const plan = buildFireResponse({ incident: { kind: 'fire', start: 36000 }, location: cds, hazard: { activeUntil: 37800 } }, transit, day.buildings);
  assert.ok(plan);
  const route = transit.routes.find(r => r.id === plan.routeId);
  assert.ok(route.kind === 'bus' || route.kind === 'shuttle');
  const raws = route.paths.filter(p => p.direction === plan.direction).map(p => p.path);
  assert.equal(plan.trucks.length, 2);
  const target = day.buildings.filter(b => b.id === cds.building);
  for (const [, frames] of sweep(plan, 2)) for (const f of frames) {
    assert.ok(Math.min(...raws.map(p => toPolyline(f.position, p))) <= 2 * A.laneOffsetMetres + 0.5, `${f.id} off corridor`);
    if (f.phase === 'staging' || f.phase === 'fighting')
      for (const p of body(f)) for (const b of day.buildings) assert.ok(!inside(p, b.polygon), `${f.id} parked inside ${b.id}`);
    if (f.waterTarget) {
      assert.ok(metres(f.position, f.waterTarget) <= A.maxHoseMetres);
      assert.ok(Math.min(...target.map(b => footprintDistance(f.waterTarget, b.polygon))) < 0.5);
    }
  }
});
