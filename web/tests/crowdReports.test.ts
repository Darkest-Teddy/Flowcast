import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addSuggestion, bostonHour, emptyPromptState, markHandled, mostly, parsePromptState, pickPrompt, reportSummary,
  PROMPT_MIN_AGE_MS, PROMPT_WINDOW_MS, type CrowdPromptState,
} from '../src/lib/crowdReports.ts';
import type { CrowdReportSummary } from '../src/data/types.ts';

// Wednesday 28 Oct 2026, Boston is UTC-4.
const at = (hhmm: string) => Date.parse(`2026-10-28T${hhmm}:00-04:00`);
const suggest = (state: CrowdPromptState, locationId: string, arrive: string, openId: string, now = at('11:00'), source: 'gap' | 'study' = 'gap') =>
  addSuggestion(state, { locationId, at: at(arrive), source, openId }, now);

test('asks on a later open about the latest suggested visit that has passed', () => {
  const state = suggest(emptyPromptState(), 'marciano', '12:10', 'open-1');
  assert.equal(pickPrompt(state, at('12:05'), 'open-2'), null, 'not before the visit');
  assert.equal(pickPrompt(state, at('12:15'), 'open-2'), null, 'not straight after arriving');
  assert.equal(pickPrompt(state, at('13:30'), 'open-1'), null, 'never on the open that suggested it');
  assert.equal(pickPrompt(state, at('13:30'), 'open-2')?.locationId, 'marciano');
  assert.equal(pickPrompt(state, at('12:10') + PROMPT_WINDOW_MS + 60_000, 'open-2'), null, 'not after about six hours');
  assert.ok(PROMPT_MIN_AGE_MS > 0);
});

test('only the most recent past suggestion, and only once', () => {
  let state = suggest(emptyPromptState(), 'marciano', '12:10', 'open-1');
  state = suggest(state, 'mugar', '14:00', 'open-2', at('13:50'), 'study');
  state = suggest(state, 'fitrec', '18:00', 'open-3', at('15:00'));
  const first = pickPrompt(state, at('15:30'), 'open-4');
  assert.equal(first?.locationId, 'mugar', 'latest past visit; future fitrec waits');
  state = markHandled(state, first!.id);
  assert.equal(pickPrompt(state, at('15:31'), 'open-5'), null, 'handled (shown) means never asked again, and older ones are not asked instead');
  assert.equal(pickPrompt(state, at('18:30'), 'open-6')?.locationId, 'fitrec');
});

test('re-renders within one open update one suggestion, keeping its id', () => {
  let state = suggest(emptyPromptState(), 'marciano', '12:10', 'open-1');
  const id = state.suggestions[0].id;
  state = suggest(state, 'marciano', '12:11', 'open-1');
  state = suggest(state, 'marciano', '12:12', 'open-1');
  assert.equal(state.suggestions.length, 1);
  assert.equal(state.suggestions[0].id, id); assert.equal(state.suggestions[0].at, at('12:12'));
  state = markHandled(state, id);
  state = suggest(state, 'marciano', '12:13', 'open-1');
  assert.ok(state.handled.includes(id), 'handled state survives the update');
  state = suggest(state, 'marciano', '17:00', 'open-2', at('16:50'));
  assert.equal(state.suggestions.length, 2, 'a later open is a new suggestion');
});

test('storage is bounded and old or malformed entries are dropped', () => {
  let state = emptyPromptState();
  for (let i = 0; i < 20; i++) state = suggest(state, `p${i}`, '12:00', `open-${i}`);
  assert.equal(state.suggestions.length, 8);
  state = addSuggestion(state, { locationId: 'late', at: at('12:00') + PROMPT_WINDOW_MS + 3600_000, source: 'gap', openId: 'x' }, at('12:00') + PROMPT_WINDOW_MS + 3600_000);
  assert.deepEqual(state.suggestions.map((s) => s.locationId), ['late']);
  for (const raw of [null, '', 'not json', '42', '{"suggestions":"x"}']) assert.deepEqual(parsePromptState(raw), emptyPromptState());
  const parsed = parsePromptState(JSON.stringify({ suggestions: [{ id: 'a', locationId: 'm', at: 1, source: 'gap', openId: 'o' }, { id: 'b', locationId: 'm', at: 'soon', source: 'gap', openId: 'o' }, { id: 'c', locationId: 'm', at: 1, source: 'other', openId: 'o' }], handled: ['a', 3] }));
  assert.deepEqual(parsed, { suggestions: [{ id: 'a', locationId: 'm', at: 1, source: 'gap', openId: 'o' }], handled: ['a'] });
});

test('student report lines: hour when enough reports, else the place; labelled and never shown when sparse', () => {
  const summary: CrowdReportSummary = { label: 'student reports', since: '2026-10-22', days: 7, minReports: 3, note: '', places: [
    { locationId: 'marciano', quiet: 1, ok: 2, packed: 9, total: 12, hours: [{ hour: 12, quiet: 0, ok: 1, packed: 7, total: 8 }] },
    { locationId: 'mugar', quiet: 2, ok: 2, packed: 1, total: 5, hours: [] },
  ] };
  assert.equal(reportSummary(summary, 'marciano'), 'Students reported: mostly Packed (12 reports this week)');
  assert.equal(reportSummary(summary, 'marciano', 12, '12 PM'), 'Students reported: mostly Packed around 12 PM (8 reports this week)');
  assert.equal(reportSummary(summary, 'marciano', 15, '3 PM'), 'Students reported: mostly Packed (12 reports this week)');
  assert.equal(reportSummary(summary, 'mugar'), 'Students reported: mixed (5 reports this week)');
  assert.equal(reportSummary(summary, 'gsu'), null);
  assert.equal(reportSummary(null, 'marciano'), null);
  assert.equal(reportSummary({ ...summary, days: 14 }, 'marciano'), 'Students reported: mostly Packed (12 reports in the last 14 days)');
  assert.equal(mostly({ quiet: 2, ok: 2, packed: 0, total: 4 }), 'mixed');
  assert.equal(bostonHour(at('12:10')), 12); assert.equal(bostonHour(at('00:30')), 0);
});
