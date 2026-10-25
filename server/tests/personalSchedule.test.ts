import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { RunContext } from '@openai/agents';
import { ScriptedModel, assistantMessage, functionCall } from '@openai/agents/testing';
import type { PersonalSchedule } from '../../map-client/src/personalSchedule';
import { personalScheduleSchema, personalScheduleFacts } from '../src/personalSchedule';
import { AskRequest, ChatRequest, createApp } from '../src/app';
import { createTools, newToolLog, mapOutput } from '../src/tools';
import { createChatTools } from '../src/chatTools';
import type { ServerAskContext } from '../src/facts';
import type { CampusModel } from '../src/campus';
import { askAgent, unsupportedNumberCount, unsupportedNumbers } from '../src/agent';
import { chatAgent, chatUnsupportedNumberCount } from '../src/chat';

const item = (title: string, start: string, end: string) => ({ title, start, end, locationId: 'cas', locationText: 'Room 987' });
const schedule: PersonalSchedule = {
  asOf: '2026-11-01T06:30:00Z', windowStart: '2026-10-31T06:30:00Z', windowEnd: '2026-11-15T06:30:00Z', truncated: false,
  items: [
    item('Later class', '2026-11-02T15:00:00Z', '2026-11-02T16:00:00Z'),
    item('Current class', '2026-11-01T05:30:00Z', '2026-11-01T07:00:00Z'),
    item('Ended class', '2026-11-01T05:00:00Z', '2026-11-01T06:30:00Z'),
    item('Starts now', '2026-11-01T06:30:00Z', '2026-11-01T07:00:00Z'),
  ],
};
const ctx: ServerAskContext = { locations: [], walkRoutes: {}, meetings: [], occupancyAt: () => [], weekday: 2, time: 45000, campus: 'charles-river' };
const valid = { weekday: 2, time: 45000, campus: 'charles-river', question: 'My next class?', messages: [{ role: 'user', text: 'My next class?' }] };

test('schedule validation enforces bounds, real offset dates, intervals and window coverage in both contracts', () => {
  for (const schema of [AskRequest, ChatRequest]) {
    assert.ok(schema.safeParse(valid).success);
    assert.ok(schema.safeParse({ ...valid, personalSchedule: schedule }).success);
    const bad = [null, {}, { ...schedule, truncated: 'false' }, { ...schedule, items: Array(101).fill(schedule.items[0]) },
      { ...schedule, asOf: '2026-11-01T06:30:00' }, { ...schedule, asOf: '2026-02-30T06:30:00Z' },
      { ...schedule, asOf: schedule.windowEnd }, { ...schedule, asOf: '2026-10-30T00:00:00Z' },
      { ...schedule, windowEnd: '2026-11-17T06:30:01Z' }, { ...schedule, windowEnd: schedule.windowStart },
      ...['title', 'locationId', 'locationText'].map((field) => ({ ...schedule, items: [{ ...schedule.items[0], [field]: 'x'.repeat(field === 'locationText' ? 201 : 161) }] })),
      ...[
        item('equal', schedule.asOf, schedule.asOf), item('reversed', schedule.windowEnd, schedule.asOf),
        item('outside', schedule.windowEnd, '2026-11-16T00:00:00Z'),
        item('touches', '2026-10-30T00:00:00Z', schedule.windowStart),
      ].map((i) => ({ ...schedule, items: [i] })),
    ];
    for (const personalSchedule of bad) assert.equal(schema.safeParse({ ...valid, personalSchedule }).success, false, JSON.stringify(personalSchedule));
  }
  assert.ok(personalScheduleSchema.safeParse({ ...schedule, windowEnd: '2026-11-16T06:30:00Z', items: Array(100).fill(schedule.items[0]) }).success);
  assert.ok(personalScheduleSchema.safeParse({ ...schedule, asOf: '2026-11-01T01:30:00-05:00', items: [] }).success);
  const sanitized = personalScheduleSchema.parse({ ...schedule, email: 'private', items: [{ ...schedule.items[0], calendar: 'private' }] });
  assert.equal('email' in sanitized, false);
  assert.equal('calendar' in sanitized.items[0], false);
});

test('facts use actual Boston dates across DST, handle overlaps and sort without modifying input', () => {
  const before = structuredClone(schedule);
  const facts = personalScheduleFacts(schedule);
  assert.equal(facts.timeZone, 'America/New_York');
  assert.equal(facts.actualAsOf, schedule.asOf);
  assert.deepEqual(facts.asOfLocal, { date: '2026-11-01', time: '1:30 AM EST' });
  assert.deepEqual(facts.current.map((i) => i.title), ['Current class', 'Starts now']);
  assert.equal(facts.current[0].startLocal.time, '1:30 AM EDT');
  assert.equal(facts.next?.title, 'Later class');
  assert.equal(facts.next?.startLocal.date, '2026-11-02');
  assert.equal(facts.upcoming.length, 1);
  assert.deepEqual(schedule, before);
  const empty = personalScheduleFacts({ ...schedule, items: [], truncated: true });
  assert.equal(empty.next, null);
  assert.deepEqual(empty.current, []);
  assert.equal(empty.truncated, true);
  assert.match(empty.note, /outside|omitted/);
});

test('personal tool exists only for supplied context, grounds numbers and produces no public outputs', async () => {
  for (const factory of [createTools, (c: ServerAskContext, log: ReturnType<typeof newToolLog>) => createChatTools({ ...c, date: null }, log)]) {
    assert.equal(factory(ctx, newToolLog()).some((t) => t.name === 'personal_schedule'), false);
    const logs = [newToolLog(), newToolLog()];
    const schedules = [schedule, { ...schedule, items: [item('Other person', '2026-11-03T12:00:00Z', '2026-11-03T13:00:00Z')] }];
    await Promise.all(schedules.map(async (personalSchedule, i) => {
      const t = factory({ ...ctx, personalSchedule }, logs[i]).find((t) => t.name === 'personal_schedule')!;
      await t.invoke(new RunContext(), '{}');
    }));
    assert.match(logs[0].outputs[0], /Later class/);
    assert.doesNotMatch(logs[0].outputs[0], /Other person/);
    assert.doesNotMatch(logs[1].outputs[0], /Later class/);
    assert.deepEqual(logs[0].calls, ['personal_schedule']);
    assert.deepEqual(unsupportedNumbers('Room 987 at 10:00 AM on 2026-11-02.', logs[0].outputs), []);
    assert.deepEqual(mapOutput(logs[0]), { show: null, rows: [] });
  }
});

test('both agents use fresh schedule tool facts and instructions without map visuals or citations', async () => {
  for (const chat of [false, true]) {
    const model = new ScriptedModel([[functionCall('personal_schedule', {}, { callId: 'schedule' })], [assistantMessage('Your saved class is in Room 987 at 10:00 AM on 2026-11-02.')]]);
    const before = chat ? chatUnsupportedNumberCount() : unsupportedNumberCount();
    const c = { ...ctx, personalSchedule: schedule, date: null };
    const result = chat
      ? await chatAgent({ messages: valid.messages as [{ role: 'user'; text: string }] }, c, {} as Parameters<typeof chatAgent>[2], undefined, model)
      : await askAgent(valid.question, c, undefined, model);
    assert.deepEqual(result.calls, ['personal_schedule']);
    assert.equal(result.show, null);
    if ('visuals' in result) {
      assert.deepEqual(result.visuals, []);
      assert.deepEqual(result.sources, []);
      assert.equal(result.mapLink, null);
    }
    assert.equal(chat ? chatUnsupportedNumberCount() : unsupportedNumberCount(), before);
    const instructions = String(model.calls[0].request.systemInstructions);
    for (const rule of [/actualAsOf/, /Boston dates/, /untrusted data/, /attendance/, /truncated/]) assert.match(instructions, rule);
  }
});

test('HTTP contexts isolate concurrent users and absent schedules; invalid and oversized bodies never reach callbacks', async () => {
  const playback = { occupancyAt: () => [] };
  const campus = { locations: [{ campus: 'charles-river' }], walkRoutes: {}, meetings: [], facts: { data: {} }, ready: () => playback } as unknown as CampusModel;
  const seen: ServerAskContext[] = [];
  const record = async (c: ServerAskContext) => {
    seen.push(c);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { answer: c.personalSchedule?.items[0]?.title ?? 'none', model: 'test', show: null, rows: [], calls: [] };
  };
  const app = createApp({ campus, keyConfigured: true, model: 'test', perMinute: 100, ask: (_q, c) => record(c), chat: async (_input, c) => ({ ...await record(c), visuals: [], sources: [], followUps: [], mapLink: null }) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    for (const path of ['/api/ask', '/api/chat']) {
      const replies = await Promise.all([schedule, { ...schedule, items: [{ ...schedule.items[0], title: 'Second user' }] }, undefined].map((personalSchedule) => post(path, { ...valid, personalSchedule })));
      assert.deepEqual(await Promise.all(replies.map(async (r) => { assert.equal(r.status, 200); return (await r.json()).answer; })), ['Later class', 'Second user', 'none']);
      assert.equal((await post(path, { ...valid, personalSchedule: { ...schedule, items: Array(101).fill(schedule.items[0]) } })).status, 400);
      assert.equal((await post(path, { ...valid, personalSchedule: schedule, padding: 'x'.repeat(132_000) })).status, 413);
    }
    assert.equal(seen.length, 6);
    assert.equal(new Set(seen).size, 6);
    assert.equal('personalSchedule' in seen[2], false);
    assert.equal('personalSchedule' in seen[5], false);
    assert.equal('personalSchedule' in campus, false);
    assert.equal('personalSchedule' in campus.facts, false);
    assert.equal('personalSchedule' in playback, false);
  } finally { server.close(); }
});
