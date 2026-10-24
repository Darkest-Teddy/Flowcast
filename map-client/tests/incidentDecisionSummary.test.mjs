import assert from 'node:assert/strict';
import { test } from 'node:test';
import { incidentDecisionSummary } from '../src/sim/incidentDecisionSummary.ts';

test('decision summaries group reasons and destinations without revealing future choices', () => {
  const meal = { activity:'dining', action:'relocate', destinationId:'dining-west', reason:'Enough time to finish the meal.', at:120 };
  const participants = [{decision:meal}, {decision:{...meal,at:140}},
    {decision:{...meal,destinationId:'dining-east'}},
    {decision:{...meal,activity:'class',action:'wait',reason:'Class remains at its scheduled location.',at:150}}, {}];
  const before = JSON.stringify(participants);
  assert.deepEqual(incidentDecisionSummary(participants,119),[]);
  assert.equal(incidentDecisionSummary(participants,130).length,2);
  const later = incidentDecisionSummary(participants,150);
  assert.equal(later.length,3);
  assert.equal(later[0].count,2);
  assert.equal(later[0].destinationId,'dining-west');
  assert.equal(incidentDecisionSummary(participants,130).reduce((n,g)=>n+g.count,0),2);
  assert.equal(JSON.stringify(participants),before);
});

test('moving on to different schedules shares a reason without implying a common destination', () => {
  const decision = { activity:'class', action:'leave', reason:'Class ends before reopening.', at:100 };
  const groups = incidentDecisionSummary([{decision:{...decision,destinationId:'home'}},
    {decision:{...decision,destinationId:'next-class'}}],100);
  assert.equal(groups.length,1);
  assert.equal(groups[0].count,2);
  assert.equal(groups[0].destinationId,undefined);
});
