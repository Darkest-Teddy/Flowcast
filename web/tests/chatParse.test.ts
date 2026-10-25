import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChatResponse, parseDirectoryResponse, parseVisual, safeMapLink, safeUrl, CHAT_LIMITS } from '../src/lib/chatParse.ts';

const line = {
  id: 'v1', kind: 'line', title: 'Mugar over the day', source: 'simulated', note: 'Simulated students over published seats',
  unit: '% full', x: ['8 AM', '9 AM', '10 AM'], series: [{ name: 'Mugar', values: [20, null, 60] }], marker: { index: 1, label: 'Now' },
};
const bar = { id: 'v2', kind: 'bar', title: 'Libraries', source: 'simulated', note: null, unit: '% full', bars: [{ label: 'Mugar', value: 78, level: 'Busy', detail: null }] };
const table = { id: 'v3', kind: 'table', title: 'Hours', source: 'published', note: null, columns: [{ key: 'n', label: 'Name', align: 'left' }], rows: [{ n: 'GSU' }] };
const stats = { id: 'v4', kind: 'stats', title: 'Now', source: 'mixed', note: null, items: [{ label: 'Open', value: '5 of 6', detail: null }] };

const good = {
  answer: '  **Mugar** is busy.  ',
  visuals: [line, bar, table, stats],
  show: null,
  mapLink: '/map?at=14:00&speed=1',
  sources: [{ label: 'BU class schedule', domain: 'crowds', kind: 'published', url: 'https://www.bu.edu/' }],
  followUps: ['When is SEL quiet?'],
  model: 'gpt-x',
  calls: ['crowd_timeline'],
};

test('a good response parses whole', () => {
  const r = parseChatResponse(200, good);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.answer, '**Mugar** is busy.');
  assert.deepEqual(r.value.visuals.map((v) => v.kind), ['line', 'bar', 'table', 'stats']);
  assert.equal(r.value.mapLink, '/map?at=14:00&speed=1');
  assert.equal(r.value.sources[0].url, 'https://www.bu.edu/');
  assert.deepEqual(r.value.followUps, ['When is SEL quiet?']);
  const v = r.value.visuals[0];
  assert.ok(v.kind === 'line' && v.series[0].values[1] === null && v.marker?.label === 'Now');
});

test('a 200 without an answer is unavailable, never a crash', () => {
  for (const body of [null, {}, { answer: '   ' }, { answer: 3 }, 'text', []]) {
    const r = parseChatResponse(200, body);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.kind, 'unavailable');
  }
});

test('malformed visuals are dropped and the rest kept', () => {
  const r = parseChatResponse(200, {
    ...good,
    visuals: [
      { ...line, series: [{ name: 'Short', values: [1, 2] }] }, // wrong length
      { ...line, id: 'nolines', series: [] },
      { ...line, id: 'allnull', series: [{ name: 'Empty', values: [null, null, null] }] },
      { ...line, id: 'badx', x: ['8 AM', { h: 9 }, '10 AM'] },
      { ...bar, source: 'guessed' }, // unknown provenance
      { ...bar, id: 'nobars', bars: [{ value: 3 }] }, // no label
      { id: 'p', kind: 'pie', title: 'Pie', source: 'simulated' },
      { ...table, id: 'nocols', columns: [] },
      { ...stats, id: 'noitems', items: [{ label: 'x' }] },
      { ...stats, id: '', title: 'no id' },
      'junk',
      null,
      stats,
      { ...stats }, // duplicate id
    ],
  });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.value.visuals.map((v) => v.id), ['v4']);
});

test('a bad marker is dropped, the line kept', () => {
  const v = parseVisual({ ...line, marker: { index: 99, label: 'Later' } });
  assert.ok(v && v.kind === 'line' && v.marker === null);
});

test('oversized responses are capped to the contract', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ ...stats, id: `s${i}` }));
  const bars = Array.from({ length: 30 }, (_, i) => ({ label: `B${i}`, value: i, level: null, detail: null }));
  const rows = Array.from({ length: 80 }, (_, i) => ({ n: `R${i}` }));
  const series = Array.from({ length: 7 }, (_, i) => ({ name: `S${i}`, values: [1, 2, 3] }));
  const items = Array.from({ length: 10 }, (_, i) => ({ label: `I${i}`, value: String(i), detail: null }));
  const r = parseChatResponse(200, {
    ...good,
    answer: 'x'.repeat(10_000),
    followUps: ['a', 'b', 'c', 'd', 'e'],
    sources: Array.from({ length: 40 }, (_, i) => ({ label: `Set ${i}`, domain: 'crowds', kind: 'published', url: null })),
    visuals: [{ ...bar, bars }, { ...table, rows }, { ...line, series }, { ...stats, items }, ...many],
  });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.value.answer.length, CHAT_LIMITS.answerChars);
  assert.equal(r.value.followUps.length, 3);
  assert.equal(r.value.sources.length, CHAT_LIMITS.sources);
  assert.equal(r.value.visuals.length, 4);
  const [b, t, l, s] = r.value.visuals;
  assert.ok(b.kind === 'bar' && b.bars.length === 12);
  assert.ok(t.kind === 'table' && t.rows.length === 25);
  assert.ok(l.kind === 'line' && l.series.length === 4);
  assert.ok(s.kind === 'stats' && s.items.length === 6);
  // A line with an absurd number of points is dropped.
  assert.equal(parseVisual({ ...line, x: Array(500).fill('t'), series: [{ name: 'a', values: Array(500).fill(1) }] }), null);
});

test('table cells keep only their columns, as text, numbers or null', () => {
  const v = parseVisual({
    ...table,
    columns: [...table.columns, { key: 'n', label: 'Dup', align: 'left' }, { key: 's', label: 'Seats', align: 'right' }],
    rows: [{ n: 'GSU', s: 600, extra: '<b>', bad: {} }, { n: { x: 1 } }],
  });
  assert.ok(v && v.kind === 'table');
  assert.deepEqual(v.columns.map((c) => c.key), ['n', 's']);
  assert.deepEqual(v.rows, [{ n: 'GSU', s: 600 }, { n: null, s: null }]);
});

test('links: only http(s) sources and relative /map links survive', () => {
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('data:text/html,hi'), null);
  assert.equal(safeUrl('/relative'), null);
  assert.equal(safeUrl('https://www.bu.edu/dining/'), 'https://www.bu.edu/dining/');
  assert.equal(safeMapLink('/map?at=12:20&speed=1'), '/map?at=12:20&speed=1');
  assert.equal(safeMapLink('/map'), '/map');
  assert.equal(safeMapLink('//evil.example/map'), null);
  assert.equal(safeMapLink('https://evil.example/map?at=1'), null);
  assert.equal(safeMapLink('/admin'), null);
  assert.equal(safeMapLink('/map?at=1', 'https://map.example/map'), 'https://map.example/map?at=1');
  const r = parseChatResponse(200, { ...good, mapLink: 'javascript:alert(1)', sources: [{ ...good.sources[0], url: 'javascript:x' }, { label: 'no kind' }] });
  assert.ok(r.ok && r.value.mapLink === null && r.value.sources.length === 1 && r.value.sources[0].url === null);
});

test('error statuses map like /api/ask', () => {
  const error = (status: number, body: unknown, header: string | null = null) => {
    const r = parseChatResponse(status, body, header);
    assert.equal(r.ok, false);
    return r.ok ? null : r.error;
  };
  assert.equal(error(400, { error: 'Bad question' })?.kind, 'badRequest');
  assert.equal(error(400, { error: 'Bad question' })?.message, 'Bad question');
  assert.deepEqual(error(429, { error: 'Slow down' }), { kind: 'rateLimited', message: 'Slow down', retryAfter: 60 });
  assert.equal(error(503, { error: 'Ask is not configured: set OPENAI_API_KEY' })?.kind, 'notConfigured');
  assert.deepEqual(error(503, { error: 'Warming', retryAfter: 8 }), { kind: 'warming', message: 'Warming', retryAfter: 8 });
  assert.equal(error(503, { error: 'Warming' }, '500')?.retryAfter, 30); // capped
  assert.equal(error(503, { error: 'Down' })?.kind, 'unavailable');
  assert.equal(error(504, { error: 'Too slow' })?.kind, 'timeout');
  assert.equal(error(502, { error: 'Model error' })?.kind, 'unavailable');
  assert.equal(error(502, null)?.kind, 'network'); // a dev proxy with no server behind it
  assert.equal(error(404, null)?.kind, 'network');
});

test('directory parses, drops malformed domains and datasets', () => {
  const r = parseDirectoryResponse(200, {
    chatAvailable: false,
    model: 'gpt-x',
    domains: [
      {
        id: 'crowds', title: 'Crowds', description: 'Who is where.', examples: ['When is Mugar quiet?', 4],
        datasets: [
          { name: 'Schedule', kind: 'published', period: 'Fall 2026', url: 'https://www.bu.edu/', coverage: '3,805 meetings' },
          { name: 'No kind' },
          { name: 'Bad link', kind: 'assumption', url: 'javascript:1' },
        ],
      },
      { id: 'crowds', title: 'Duplicate' },
      { title: 'No id' },
      null,
    ],
  });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.value.chatAvailable, false);
  assert.equal(r.value.domains.length, 1);
  const d = r.value.domains[0];
  assert.deepEqual(d.examples, ['When is Mugar quiet?']);
  assert.deepEqual(d.datasets.map((x) => [x.name, x.url]), [['Schedule', 'https://www.bu.edu/'], ['Bad link', null]]);
});

test('directory: no server is unreachable, other failures say why', () => {
  const none = parseDirectoryResponse(502, null);
  assert.ok(!none.ok && none.error.kind === 'unreachable');
  const html = parseDirectoryResponse(200, null); // an HTML page where JSON was expected
  assert.ok(!html.ok && html.error.kind === 'unreachable');
  const broken = parseDirectoryResponse(500, { error: 'Directory failed' });
  assert.ok(!broken.ok && broken.error.kind === 'unavailable' && broken.error.message === 'Directory failed');
});
