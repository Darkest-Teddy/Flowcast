import assert from 'node:assert/strict';
import { test } from 'node:test';
import { casualtiesAt, incidentProgress, injuryClusters } from '../src/sim/incidentProgress.ts';

const run = {
  incident: { id:'drill',kind:'fire-drill',locationId:'hall',start:100,duration:200 },
  endsAt:300,
  participants:[
    {agentId:'first',role:'occupant',departAt:120,assemblyAt:150,releaseAt:300,resumedAt:340},
    {agentId:'last',role:'occupant',departAt:140,assemblyAt:170,releaseAt:310,resumedAt:350},
    {agentId:'incoming',role:'arrival',departAt:160,assemblyAt:null,releaseAt:300,resumedAt:330},
  ],
};

test('incident progress separates clearing, outdoor assembly, and staggered recovery', () => {
  assert.equal(incidentProgress(run,99).phase,'Scheduled');
  assert.equal(incidentProgress(run,99).inside,0);
  assert.equal(incidentProgress(run,100).inside,2);
  const leaving=incidentProgress(run,130);
  assert.equal(leaving.phase,'Evacuating');
  assert.equal(leaving.inside,1);
  assert.equal(leaving.evacuating,1);
  const waiting=incidentProgress(run,170);
  assert.equal(waiting.phase,'Access closed');
  assert.equal(waiting.assembled,2);
  assert.equal(waiting.diverted,1);
  assert.equal(waiting.clearedAt,140);
  const reopening=incidentProgress(run,300);
  assert.equal(reopening.phase,'Resuming');
  assert.equal(reopening.assembled,1);
  assert.equal(reopening.recovering,2);
  assert.equal(incidentProgress(run,340).resumed,2);
  assert.equal(incidentProgress(run,350).phase,'Complete');
  assert.equal(incidentProgress(run,350).resumed,3);
  assert.equal(incidentProgress(run,130).inside,1,'rewinding is deterministic');
});

test('an empty building remains closed until expiry without invented evacuees', () => {
  const empty={...run,participants:[]};
  assert.equal(incidentProgress(empty,100).phase,'Access closed');
  assert.equal(incidentProgress(empty,299).occupantCount,0);
  assert.equal(incidentProgress(empty,300).phase,'Complete');
});

test('routine closures report clearing and recovery without assembly', () => {
  const closure = {
    ...run,
    incident: { ...run.incident, kind: 'building-closure' },
    participants: [{ agentId:'leaving', role:'occupant', departAt:120, assemblyAt:null, releaseAt:120, resumedAt:180, outcome:'cancelled' }],
  };
  assert.equal(incidentProgress(closure,100).phase,'Clearing building');
  const leaving = incidentProgress(closure,130);
  assert.equal(leaving.phase,'Access closed');
  assert.equal(leaving.recovering,1);
  assert.equal(leaving.cancelled,1);
  assert.equal(incidentProgress(closure,100).cancelled,0);
  assert.equal(leaving.assembled,0);
  assert.equal(leaving.evacuating,0);
  assert.equal(incidentProgress(closure,180).resumed,1);
  assert.equal(incidentProgress(closure,300).phase,'Complete');
});

test('relocation counts start when the choice takes effect and rewind with the clock', () => {
  const relocated = { ...run, participants: [{ agentId:'reader', role:'occupant', departAt:120,
    assemblyAt:null, releaseAt:120, resumedAt:180, outcome:'relocated',
    decision:{activity:'library',action:'relocate',reason:'Another library is available.',at:120} }] };
  assert.equal(incidentProgress(relocated,119).relocated,0);
  assert.equal(incidentProgress(relocated,120).relocated,1);
  assert.equal(incidentProgress(relocated,119).relocated,0);
});

test('earthquake progress shows shaking before clearing and rewinds deterministically', () => {
  const quake = { ...run, incident: { ...run.incident, kind: 'earthquake' },
    hazard: { radiusMetres: 250, responseStartsAt: 160, activeUntil: 300,
      affectedLocationIds: ['hall'], affectedBuildingIds: ['hall'] },
    participants: [{ agentId: 'sheltering', role: 'occupant', departAt: 180,
      assemblyAt: null, releaseAt: 300, resumedAt: 340, outcome: 'interrupted' }] };
  assert.equal(incidentProgress(quake, 99).phase, 'Scheduled');
  assert.equal(incidentProgress(quake, 100).phase, 'Sheltering during shaking');
  assert.equal(incidentProgress(quake, 159).inside, 1);
  assert.equal(incidentProgress(quake, 160).phase, 'Clearing building');
  assert.equal(incidentProgress(quake, 180).phase, 'Access closed');
  assert.equal(incidentProgress(quake, 340).phase, 'Complete');
  assert.equal(incidentProgress(quake, 100).phase, 'Sheltering during shaking');
});

test('damage closure persists after active effects finish', () => {
  const damaged = { ...run, endsAt: 86400, incident: { ...run.incident, kind: 'meteor' },
    hazard: { radiusMetres: 100, responseStartsAt: 100, activeUntil: 300,
      affectedLocationIds: ['hall'], affectedBuildingIds: ['hall'] }, participants: [] };
  assert.equal(incidentProgress(damaged, 99).phase, 'Scheduled');
  assert.equal(incidentProgress(damaged, 299).phase, 'Access closed');
  assert.equal(incidentProgress(damaged, 300).phase, 'Buildings damaged');
  assert.equal(incidentProgress(damaged, 86399).phase, 'Buildings damaged');
  assert.equal(incidentProgress(damaged, 299).phase, 'Access closed');
});

const fire = {
  incident: { id: 'fire', kind: 'fire', locationId: 'hall', start: 100, duration: 1800 },
  endsAt: 86400,
  hazard: { radiusMetres: 0, responseStartsAt: 100, activeUntil: 1900, affectedLocationIds: ['hall'], affectedBuildingIds: ['hall'] },
  participants: [
    { agentId: 'a', role: 'occupant', departAt: 150, assemblyAt: null, releaseAt: 150, resumedAt: 400, outcome: 'cancelled' },
    { agentId: 'b', role: 'occupant', departAt: 160, assemblyAt: null, releaseAt: 160, resumedAt: 420, outcome: 'cancelled' },
    { agentId: 'c', role: 'occupant', departAt: 170, assemblyAt: null, releaseAt: 170, resumedAt: 440, outcome: 'cancelled' },
    { agentId: 'd', role: 'occupant', departAt: 180, assemblyAt: null, releaseAt: 180, resumedAt: 460, outcome: 'cancelled' },
  ],
  casualties: [
    { agentId: 'a', outcome: 'injured', at: 120, position: [-71.1, 42.35], cause: 'fire', buildingId: 'hall' },
    { agentId: 'b', outcome: 'fatality', at: 130, position: [-71.1, 42.35], cause: 'fire', buildingId: 'hall' },
    { agentId: 'c', outcome: 'injured', at: 300, position: [-71.1001, 42.35], cause: 'fire' },
  ],
};

test('casualty counts follow the clock at event boundaries and never include future events', () => {
  assert.deepEqual(casualtiesAt(fire, 119), []);
  let p = incidentProgress(fire, 119);
  assert.equal(p.injured, 0); assert.equal(p.fatalities, 0); assert.equal(p.inside, 4);
  p = incidentProgress(fire, 120);
  assert.equal(p.injured, 1); assert.equal(p.fatalities, 0);
  assert.equal(p.inside, 3, 'an injured occupant is not counted as able to evacuate');
  p = incidentProgress(fire, 130);
  assert.equal(p.fatalities, 1); assert.equal(p.inside, 2);
  p = incidentProgress(fire, 299);
  assert.equal(p.injured, 1, 'the 300 s injury is still in the future');
  assert.equal(p.recovering, 2, 'c and d are rejoining; a and b are not');
  assert.equal(incidentProgress(fire, 300).injured, 2);
  assert.equal(incidentProgress(fire, 300).recovering, 1);
  assert.equal(incidentProgress(fire, 119).injured, 0, 'rewinding hides events again');
});

test('a casualty is never counted as resumed, rejoining or inside', () => {
  const p = incidentProgress(fire, 1000);
  assert.equal(p.resumed, 1, 'only d resumes');
  assert.equal(p.recovering, 0);
  assert.equal(p.inside, 0);
  assert.equal(p.injured + p.fatalities + p.resumed, fire.participants.length);
  assert.equal(p.clearedAt, 180);
  assert.equal(p.cancelled, 2, 'only departures before harm remain in the cumulative counts');
});

test('incapacitation before exit clears the occupant from inside at the event time', () => {
  const early = { ...fire, participants: fire.participants.slice(0, 2) };
  assert.equal(incidentProgress(early, 140).clearedAt, 130);
  assert.equal(incidentProgress(early, 140).phase, 'Access closed');
  assert.equal(incidentProgress(early, 125).phase, 'Clearing building');
});

test('drills and closures ignore casualty data and keep their existing counts', () => {
  const drill = { ...run, casualties: [{ agentId: 'first', outcome: 'injured', at: 110, position: [0, 0], cause: 'fire' }] };
  assert.deepEqual(casualtiesAt(drill, 400), []);
  const p = incidentProgress(drill, 130);
  assert.equal(p.inside, 1); assert.equal(p.injured, 0); assert.equal(p.evacuating, 1);
  assert.equal(incidentProgress(drill, 350).resumed, 3);
});

test('injury clusters are deterministic aggregates of injured events at or before the time', () => {
  const events = [
    ...fire.casualties,
    { agentId: 'e', outcome: 'injured', at: 200, position: [-71.09, 42.351], cause: 'fire' },
  ];
  assert.deepEqual(injuryClusters(events, 119), []);
  const at250 = injuryClusters(events, 250);
  assert.equal(at250.reduce((n, c) => n + c.count, 0), 2, 'fatalities and future injuries are excluded');
  const at400 = injuryClusters(events, 400);
  assert.deepEqual(at400, injuryClusters([...events].reverse(), 400), 'input order does not matter');
  assert.equal(at400[0].count, 2, 'nearby injuries merge into one marker');
  assert.equal(at400.length, 2);
  for (const cluster of at400) assert.ok(cluster.radiusPixels >= 5 && cluster.radiusPixels <= 18);
  const merged = at400[0].position;
  assert.ok(Math.abs(merged[0] - (-71.10005)) < 1e-9 && merged[1] === 42.35, 'position is the mean of real event positions');
});


test('incapacitated agents never make later relocation choices or get diverted', () => {
  const later = { ...fire, participants: [{ ...fire.participants[0], role: 'arrival',
    decision: { activity: 'library', action: 'relocate', at: 150, reason: 'another library' } }] };
  const p = incidentProgress(later, 1000);
  assert.equal(p.relocated, 0);
  assert.equal(p.diverted, 0);
  assert.equal(p.cancelled, 0);
});
