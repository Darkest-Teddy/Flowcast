import assert from 'node:assert/strict';
import { test } from 'node:test';
import { courseLevel, countsTowardDegreeLoad, eligibleStudentLevels } from '../src/sim/courseEligibility.ts';

test('BU default course bands retain the broad mixed 400–599 range',()=>{
  assert.deepEqual(eligibleStudentLevels('CAS MA 123'),['undergraduate']);
  assert.deepEqual(eligibleStudentLevels('CAS CS 450'),['undergraduate','graduate']);
  assert.deepEqual(eligibleStudentLevels('CAS CS 599'),['undergraduate','graduate']);
  assert.deepEqual(eligibleStudentLevels('QST BA 808'),['graduate']);
});
test('professional MD and explicit graduate-school prefixes override general undergraduate numbering',()=>{
  for(const code of ['MED MD 121','GMS AN 101','GRS MA 200']) assert.equal(courseLevel(code),'graduate');
  assert.equal(courseLevel('LAW JD 100'),'undergraduate','unverified school exceptions are not invented');
});
test('nondegree and PDP offerings do not pad degree loads; unknown eligibility stays permissive',()=>{
  for(const code of ['QST ES 090','PDP FT 151']) {
    assert.equal(courseLevel(code),'nondegree');assert.equal(countsTowardDegreeLoad(code),false);
    assert.deepEqual(eligibleStudentLevels(code),['undergraduate','graduate']);
  }
  assert.equal(courseLevel('unrecognized'),'unknown');
  assert.deepEqual(eligibleStudentLevels('unrecognized'),['undergraduate','graduate']);
});
