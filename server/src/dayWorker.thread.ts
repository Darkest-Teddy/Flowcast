// The day-building thread (see dayWorker.ts). Loads the sources once, then answers each request in
// turn with that day's compact data, moving its arrays to the main thread rather than copying them.

import { parentPort, workerData } from 'node:worker_threads';
import { buildDay, loadSources } from './campus';
import { CompactDay } from './compactDay';
import type { DayReply, DayRequest } from './dayWorker';

const port = parentPort!;
const sources = loadSources((workerData as { bundlePath: string }).bundlePath);

port.on('message', ({ id, weekday }: DayRequest) => {
  let day;
  try {
    day = buildDay(sources, weekday);
  } catch (error) {
    port.postMessage({ id, error: error instanceof Error ? error.message : 'build failed' } satisfies DayReply);
    return;
  }
  if (!(day instanceof CompactDay)) {
    port.postMessage({ id, data: null } satisfies DayReply);
    return;
  }
  const { data } = day;
  port.postMessage({ id, data } satisfies DayReply, [data.starts.buffer as ArrayBuffer, data.ends.buffer as ArrayBuffer, data.to.buffer as ArrayBuffer]);
});
