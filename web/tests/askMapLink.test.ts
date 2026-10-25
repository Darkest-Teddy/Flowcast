import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerMapLink, remoteAnswerPoints } from '../src/lib/askMapLink.ts';

test('map handoff uses actual route geometry without question or history', () => {
  const result = {
    answer: 'Walk there after your private lecture', model: 'test', rows: [], calls: [],
    show: { select: null, points: [] as [number, number][], route: { path: [[-71.11, 42.35], [-71.10, 42.36]] as [number, number][], estimate: false } },
  };
  const link = answerMapLink('/map', remoteAnswerPoints(result));
  assert.equal(link, '/map?lng=-71.10500&lat=42.35500&zoom=15.8&spin=0');
  assert.equal(link?.includes('lecture'), false);
  assert.equal(link?.includes('ask='), false);
});

test('map handoff uses points without a route, and is absent without concrete geometry', () => {
  assert.equal(answerMapLink('/map', [[-71.1, 42.35]]), '/map?lng=-71.10000&lat=42.35000&zoom=17.6&spin=0');
  assert.equal(answerMapLink('/map', []), null);
  assert.equal(answerMapLink('/map', [[NaN, 42]]), null);
});
