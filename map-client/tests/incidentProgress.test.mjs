import assert from 'node:assert/strict';
import { test } from 'node:test';
import { incidentProgress } from '../src/sim/incidentProgress.ts';

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
