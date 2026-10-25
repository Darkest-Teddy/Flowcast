import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});
const { buildSourceDay } = await import('../src/sim/sourceDay.ts');
const { Playback } = await import('../src/sim/playback.ts');

function fixture() {
  const locations = ['home', 'east', 'west'].map((id, index) => ({
    id, name: id, short: id, kind: index ? 'classroom' : 'dorm',
    position: [-71.1 - index * 0.015, 42.35], capacity: 100, building: id, campus: 'main',
  }));
  const walkRoutes = {};
  for (const from of locations) for (const to of locations) if (from !== to) {
    walkRoutes[`${from.id}>${to.id}`] = { path: [from.position, to.position], cumulative: [0, Math.abs(from.position[0] - to.position[0]) * 82000] };
  }
  const base = { day: 'Monday', locations, buildings: [], trips: [], walkRoutes,
    agents: Array.from({ length: 100 }, (_, i) => ({ id: `spatial-${i}`, home: 'home', model: 0, campus: 'main', residency: 'resident' })),
  };
  const data = { schemaVersion: 1, term: 'FALL 2026', collectedAt: '2026-10-24', referenceWeekStart: '2026-10-19',
    coverage: {}, locations: {}, events: [], libraryHistory: {}, signals: [], assumptions: [], inputFiles: [] };
  for (const loc of locations) data.locations[loc.id] = { id: loc.id, buildingCodes: [], evidence: [], hours: [],
    meetings: loc.id === 'home' ? [] : Array.from({ length: 8 }, (_, i) => ({
      id: `${loc.id}-${i}`, courseCode: `CAS AA ${100 + i}`, title: `Course ${i}`, section: loc.id,
      roomCode: '100', roomCapacity: 80, notes: null, calendarRestricted: false, sharedKey: null, sourceUrl: 'fixture',
      intervals: [0, 2, 4].map(weekday => ({ weekday, startSec: weekday * 86400 + (9 + i) * 3600, endSec: weekday * 86400 + (9 + i) * 3600 + 1800 })),
    })) };
  return { base, data };
}

test('spatial course choice preserves full loads and source constraints while favoring academic clusters', () => {
  const { base, data } = fixture();
  const monday = buildSourceDay(base, data, 0);
  const repeat = fixture();
  assert.deepEqual(buildSourceDay(repeat.base, repeat.data, 0).sourceAssignments, monday.sourceAssignments);
  let sameCluster = 0, pairs = 0;
  for (const agent of base.agents) {
    const classes = monday.sourceAssignments.filter(row => row.agentId === agent.id);
    assert.ok(classes.length >= 4 && classes.length <= 5, 'spatial preference must not reduce course load');
    for (let i = 0; i < classes.length; i++) for (let j = i + 1; j < classes.length; j++) {
      pairs++;
      if (classes[i].locationId === classes[j].locationId) sameCluster++;
    }
  }
  assert.ok(sameCluster / pairs > 0.5, `same-cluster course pairs: ${sameCluster / pairs}`);
  for (const weekday of [0, 2, 4]) {
    const day = buildSourceDay(base, data, weekday);
    assert.deepEqual(day.sourceAssignments, monday.sourceAssignments);
    assert.doesNotThrow(() => new Playback(day));
    const counts = new Map();
    for (const row of day.sourceAssignments) {
      const meeting = data.locations[row.locationId].meetings.find(item => item.id === row.meetingId);
      const source = meeting.intervals.find(item => item.weekday === weekday);
      assert.equal(row.startSec, source.startSec - weekday * 86400);
      assert.equal(row.endSec, source.endSec - weekday * 86400);
      counts.set(meeting.id, (counts.get(meeting.id) ?? 0) + 1);
      assert.ok(counts.get(meeting.id) <= meeting.roomCapacity);
    }
  }
});
