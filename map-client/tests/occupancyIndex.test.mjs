import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ resolve(s, c, next) { try { return next(s, c); } catch (e) { if (s.startsWith('.') && !/\.[a-z]+$/i.test(s)) return next(`${s}.ts`, c); throw e; } } });
const { createOccupancyIndex } = await import('../src/sim/occupancyIndex.ts');

function scan(stays, time) {
  const agents = new Map();
  for (const s of stays) { const list = agents.get(s.agent) ?? []; list.push(s); agents.set(s.agent, list); }
  const counts = new Map();
  for (const list of agents.values()) {
    list.sort((a, b) => a.start - b.start);
    const s = list.find(s => s.start <= time && time < s.end);
    if (s && s.location !== 'off-campus') counts.set(s.location, (counts.get(s.location) ?? 0) + 1);
  }
  return counts;
}
test('matches first stay scans at starts, ends, gaps, random scrubs, and keeps an immutable snapshot', () => {
  const stays = [];
  let seed = 47;
  const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 4294967296);
  for (let a = 0; a < 30; a++) {
    let time = 0;
    for (let i = 0; i < 10; i++) {
      const start = time + random() * 3, end = start + random() * 10;
      stays.push({ agent: `${a}`, location: ['a', 'b', 'off-campus'][i % 3], start, end }); time = end;
    }
  }
  stays.reverse();
  stays.push({ agent: '0', location: 'a', start: 0, end: 0 });
  const index = createOccupancyIndex(stays);
  assert.ok(index);
  for (const t of [...stays.flatMap(s => [s.start - 1e-8, s.start, s.end - 1e-8, s.end, s.end + 1e-8]), ...Array.from({ length: 200 }, () => random() * 160), NaN, Infinity, -Infinity]) assert.deepEqual(index.countsAt(t), scan(stays, t));
  const before = index.countsAt(20);
  stays[0].start = -999; stays.length = 0;
  assert.deepEqual(index.countsAt(20), before);
  before.clear(); assert.notEqual(index.countsAt(20).size, 0);
});
test('rejects overlaps including off-campus stays and invalid boundaries', () => {
  const first = { agent: 'a', location: 'off-campus', start: 0, end: 10 };
  for (const second of [{ ...first, location: 'b', start: 5 }, { ...first }, { ...first, start: NaN }, { ...first, end: Infinity }, { ...first, start: 11 }]) assert.equal(createOccupancyIndex([first, second]), null);
  assert.ok(createOccupancyIndex([first, { ...first, start: 10, end: 20 }]));
  assert.deepEqual(createOccupancyIndex([]).countsAt(10), new Map());
});
test('Wednesday bundled workload matches every event boundary and random Playback scrubs', () => {
  return (async () => {
    const { buildPopulation } = await import('../src/sim/population.ts');
    const { buildSourceDay } = await import('../src/sim/sourceDay.ts');
    const { Playback } = await import('../src/sim/playback.ts');
    const read = name => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url)));
    const source = read('campus-data');
    const day = buildSourceDay(buildPopulation(read('demo-day'), source, read('population')), source, 2);
    const index = createOccupancyIndex(day.stays); assert.ok(index);
    const events = day.stays.flatMap(s => [[s.start, s.location, 1], [s.end, s.location, -1]]).sort((a, b) => a[0] - b[0]);
    const expected = new Map(); let boundaries = 0;
    for (let i = 0; i < events.length;) {
      const time = events[i][0];
      do {
        const [, location, delta] = events[i++];
        if (location === 'off-campus') continue;
        const count = (expected.get(location) ?? 0) + delta;
        if (count) expected.set(location, count); else expected.delete(location);
      } while (i < events.length && events[i][0] === time);
      assert.deepEqual(index.countsAt(time), expected); boundaries++;
    }
    const playback = new Playback(day); let indexedMs = 0, scanMs = 0;
    for (let i = 0; i < 300; i++) {
      const time = ((i * 7919) % 86400) + 0.125;
      let start = performance.now(); const fast = index.countsAt(time); indexedMs += performance.now() - start;
      start = performance.now(); const original = playback.occupancyAt(time); scanMs += performance.now() - start;
      for (const o of original) assert.equal(fast.get(o.location.id) ?? 0, o.count);
    }
    console.log(`${boundaries} Wednesday boundaries; 300 scrubs mean indexed ${(indexedMs / 300).toFixed(3)} ms, Playback ${(scanMs / 300).toFixed(3)} ms`);
  })();
});
