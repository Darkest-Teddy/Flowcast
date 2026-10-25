// Flowcast server entry point: `npm run dev` in server/.
// Reads the OpenAI key from OPENAI_KEY (or OPENAI_API_KEY). Never logs it.

import { setImmediate as nextTick } from 'node:timers/promises';
import { setDefaultOpenAIKey } from '@openai/agents';
import { WEEKDAYS } from '../../map-client/src/data/campusData';
import { ASK_MODEL, askAgent } from './agent';
import { createApp } from './app';
import { loadCampusModel } from './campus';
import { chatAgent } from './chat';
import { datasetCatalog } from './directory';

const key = process.env.OPENAI_KEY || process.env.OPENAI_API_KEY || '';
if (key) setDefaultOpenAIKey(key);

const started = Date.now();
const campus = loadCampusModel();
console.log(`campus data loaded in ${Date.now() - started} ms (${campus.privateBundle ? 'private' : 'public'} bundle, ${campus.daysCached} days cached)`);

const catalog = datasetCatalog(campus);
const app = createApp({
  campus, keyConfigured: Boolean(key), model: ASK_MODEL,
  ask: (question, ctx, signal, history) => askAgent(question, ctx, signal, ASK_MODEL, history),
  chat: (input, ctx, signal) => chatAgent(input, ctx, catalog, signal),
});
const port = Number(process.env.PORT) || 8787;
const host = process.env.HOST || '127.0.0.1';
app.listen(port, host, () => {
  console.log(`Flowcast server on http://${host}:${port} · model ${ASK_MODEL} · ${key ? 'OpenAI key set' : 'NO OpenAI key: /api/ask and /api/chat will return 503'}`);
  void prebuild();
});

/**
 * Simulates today first, then the following days, one at a time with a turn of the event loop
 * between them so waiting requests get answered (a day still being built gets a 503 "warming up").
 * Only as many days as the cache keeps are built, so prebuilding never evicts today.
 */
async function prebuild() {
  const bostonDay = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long' }).format(new Date());
  const today = Math.max(0, WEEKDAYS.indexOf(bostonDay as (typeof WEEKDAYS)[number]));
  for (let i = 0; i < campus.daysCached; i++) {
    const weekday = (today + i) % 7;
    await nextTick();
    const t0 = Date.now();
    try {
      await campus.playback(weekday);
      console.log(`${WEEKDAYS[weekday]} simulated in ${Date.now() - t0} ms${i === 0 ? ' (today, ready)' : ''}`);
    } catch (error) {
      console.error(`couldn't simulate ${WEEKDAYS[weekday]}: ${error instanceof Error ? error.name : 'unknown'}`);
    }
  }
}
