import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { transformWithOxc } from 'vite';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context); throw error; }
} });
const insights = await import('../src/insights.ts');
const { appendExchange } = await import('../src/askConversation.ts');
const routing = await import('../../web/src/lib/askRouting.ts');
const { formatClock } = await import('../src/sim/playback.ts');
const { WEEKDAYS, dateForWeekday } = await import('../src/data/campusData.ts');
const source = readFileSync(new URL('../src/AskPanel.tsx', import.meta.url), 'utf8');
const { code } = await transformWithOxc(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), 'AskPanel.tsx', { jsx: { runtime: 'classic' } });
const place = { id: 'mugar', name: 'Mugar Memorial Library', short: 'Mugar', kind: 'library', position: [-71.1, 42.3], building: 'way/1', campus: 'charles-river', capacity: 800 };
const context = { locations: [place], walkRoutes: {}, meetings: [], weekday: 0, time: 36000, campus: 'charles-river', occupancyAt: () => [], modeled: () => true };
const reply = (answer = 'Mugar is quiet.') => ({ ok: true, value: { answer, rows: [], show: { route: null, select: 'mugar', points: [place.position] } } });
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

// Execute the component's actual event handlers with deterministic hook slots. Browser layout
// and React's own scheduler remain integration checks; no DOM/test-renderer dependency is added.
function panel({ agent = async () => reply(), configured = async () => true, initialQuestion = null } = {}) {
  const slots = [];
  const effects = [];
  const requests = [];
  const shown = [];
  const selected = [];
  let cursor = 0;
  const bindings = {
    ...insights, ...routing, appendExchange, formatClock, WEEKDAYS, dateForWeekday,
    crowdLevel: () => ({ label: 'Quiet' }), crowdLevelStyle: () => ({}),
    React: { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((x) => x !== false && x != null) }) },
    useState(value) { const index = cursor++; if (!(index in slots)) slots[index] = value; return [slots[index], (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }]; },
    useRef(value) { const index = cursor++; return slots[index] ??= { current: value }; },
    useEffect(effect) { const index = cursor++; if (!(index in slots)) { slots[index] = true; effects.push(effect); } },
    agentConfigured: configured,
    askAgentWithRetry: (request, signal) => { requests.push({ request, signal }); return agent(request, signal); },
  };
  const Component = new Function(...Object.keys(bindings), `${code}\nreturn AskPanel;`)(...Object.values(bindings));
  const props = { context, initialQuestion, onShow: (show) => shown.push(show), onSelect: (location) => selected.push(location) };
  let tree;
  const render = () => { cursor = 0; tree = Component(props); return tree; };
  const nodes = (node = tree) => typeof node === 'object' ? [node, ...node.children.flatMap((child) => nodes(child))] : [];
  const text = (node = tree) => typeof node === 'object' ? node.children.map(text).join(' ') : String(node);
  render();
  return {
    requests, shown, selected, props, effects, render, text,
    find: (predicate) => nodes().find(predicate),
    all: (predicate) => nodes().filter(predicate),
    async submit(question) {
      nodes().find((n) => n.type === 'input').props.onChange({ target: { value: question } });
      render();
      nodes().find((n) => n.type === 'form').props.onSubmit({ preventDefault() {} });
      await tick(); render();
    },
    clear() { nodes().find((n) => n.type === 'button' && text(n) === 'New chat').props.onClick(); render(); },
  };
}

test('follow-ups send successful exchanges, repeat questions, preserve labels and replay old map actions', async () => {
  const p = panel();
  await p.submit('Where is Mugar?');
  p.props.context = { ...context, weekday: 1, time: 64800, campus: 'fenway' };
  p.render();
  await p.submit('add it to map too');
  assert.deepEqual(p.requests[1].request.history, [{ role: 'user', content: 'Where is Mugar?' }, { role: 'assistant', content: 'Mugar is quiet.' }]);
  assert.equal(p.requests[1].request.campus, 'fenway');
  assert.match(p.text(), /Monday.*10:00.*Charles River.*Tuesday.*6:00.*Fenway/s);
  await p.submit('add it to map too');
  assert.equal(p.requests.length, 3);
  const shows = p.all((n) => n.type === 'button' && p.text(n) === 'Show on map');
  assert.equal(shows.length, 3);
  shows[0].props.onClick();
  assert.equal(p.shown.at(-1).select.id, 'mugar');
  assert.equal(p.find((n) => n.props.role === 'log').props['aria-live'], 'polite');
});

test('local failure clears remote history and ambiguous follow-ups stay on device until a named question', async () => {
  let calls = 0;
  const p = panel({ agent: async () => ++calls === 2 ? { ok: false, error: { kind: 'network' } } : reply() });
  await p.submit('Where is Mugar?');
  await p.submit('Where is Mugar?');
  await p.submit('add it to map too');
  assert.equal(p.requests.length, 2);
  assert.match(p.text(), /Which building or place do you mean/);
  await p.submit('Where is Mugar?');
  assert.deepEqual(p.requests[2].request.history, []);
});

test('personal schedules and homes stay local without even requesting health', async () => {
  let health = 0;
  const p = panel({ configured: async () => { health++; return true; } });
  for (const question of ['Where is my next class?', 'When do I have class?', 'my calendar', 'my dorm', 'what is next']) await p.submit(question);
  assert.equal(health, 0);
  assert.equal(p.requests.length, 0);
  assert.match(p.text(), /Flowcast home page/);
});

test('New chat aborts pending reply, clears map and prevents stale completion from entering a new chat', async () => {
  let resolve;
  const p = panel({ agent: () => new Promise((done) => { resolve = done; }) });
  await p.submit('Where is Mugar?');
  p.clear();
  assert.equal(p.requests[0].signal.aborted, true);
  assert.equal(p.shown.at(-1), null);
  resolve(reply('Stale answer'));
  await tick(); p.render();
  assert.doesNotMatch(p.text(), /Stale answer|Where is Mugar/);
  await p.submit('Where is Mugar?');
  assert.deepEqual(p.requests[1].request.history, []);
  resolve(reply());
  await tick();
});

test('StrictMode setup/cleanup replay consumes initial URL once and New chat does not replay it', async () => {
  const p = panel({ initialQuestion: 'Where is Mugar?' });
  const cleanup = p.effects[0]();
  cleanup();
  const finalCleanup = p.effects[0]();
  await tick(); p.render();
  assert.equal(p.requests.length, 1);
  p.clear();
  p.effects[0]();
  await tick();
  assert.equal(p.requests.length, 1);
  finalCleanup();
});

test('cancellation while health is pending never sends the question', async () => {
  let resolve;
  const p = panel({ configured: () => new Promise((done) => { resolve = done; }) });
  await p.submit('Where is Mugar?');
  p.clear(); resolve(true);
  await tick(); p.render();
  assert.equal(p.requests.length, 0);
});

test('fallback retains submitted day and unmodeled warnings, and old rows remain selectable', async () => {
  let resolve;
  const p = panel({ agent: () => new Promise((done) => { resolve = done; }) });
  await p.submit('How busy is Mugar on Tuesday?');
  p.props.context = { ...context, weekday: 1 };
  p.render();
  resolve({ ok: false, error: { kind: 'network' } });
  await tick(); p.render();
  assert.match(p.text(), /Select Tuesday in the day picker/);
  assert.match(p.text(), /Monday/);
  p.props.context = { ...context, occupancyAt: () => [{ location: place, count: 0, modeled: false }] };
  p.render();
  await p.submit('How busy is Mugar?');
  resolve({ ok: false, error: { kind: 'network' } });
  await tick(); p.render();
  assert.match(p.text(), /doesn't model Mugar Memorial Library/);
  await p.submit('Where is Mugar?');
  resolve({ ok: true, value: { ...reply().value, rows: [{ id: 'mugar', percent: 12, students: 96, modeled: true, open: true, walkMinutes: null }] } });
  await tick(); p.render();
  await p.submit('add it to map too');
  p.find((n) => n.props.className === 'row').props.onClick();
  assert.equal(p.selected.at(-1).id, 'mugar');
  resolve(reply());
  await tick();
});
