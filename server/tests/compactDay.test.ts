import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expandDay, Playback } from '../../map-client/src/sim/playback';
import { buildPopulation } from '../../map-client/src/sim/population';
import { buildSourceDay } from '../../map-client/src/sim/sourceDay';
import { CompactDay, compactDay } from '../src/compactDay';

const readJson = (path: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8'));

test('a compact day answers exactly like the Playback it was built from', () => {
  const day = expandDay(readJson('map-client/public/data/demo-day.json'));
  const campus = readJson('map-client/public/data/campus-data.json');
  const base = buildPopulation(day, campus, readJson('map-client/public/data/population.json'));
  const playback = new Playback(buildSourceDay(base, campus, 2));
  const compact = compactDay(playback);
  assert.ok(compact instanceof CompactDay);
  // Every minute, odd seconds and the day's edges.
  const times = [-1, 86399.999, 86400, 90000, ...Array.from({ length: 1441 }, (_, m) => m * 60), ...Array.from({ length: 200 }, (_, i) => i * 431.7 + 0.25)];
  for (const t of times) {
    const occupancy = (view: { occupancyAt(t: number): { location: { id: string }; count: number; share: number; modeled?: boolean }[] }) =>
      view.occupancyAt(t).map((o) => [o.location.id, o.count, o.share, o.modeled]);
    assert.deepEqual(occupancy(compact), occupancy(playback), `occupancy at ${t}`);
    assert.deepEqual(compact.populationAt(t), playback.populationAt(t), `population at ${t}`);
    assert.deepEqual(compact.walkingAt(t).map((w) => w.to).sort(), playback.walkingAt(t).map((w) => w.to).sort(), `walkers at ${t}`);
  }
});
