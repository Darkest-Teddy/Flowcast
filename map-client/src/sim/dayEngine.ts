// Main-thread side of the conditions engine: asks the day worker for conditioned days and turns
// each reply into a Playback in small idle-time slices, so the map keeps drawing at full rate
// while a new day is prepared. The previous day stays on screen until the new one is ready.
import type { AcademicCalendar } from '../data/academicCalendar';
import { conditionsFor, conditionsKey, type ConditionsInput } from './conditions';
import { decodeDaySteps, type DecodedDay, type EncodedDay } from './dayCodec';
import type { DayComparison } from './compare';
import type { DayInfo } from './explain';
import { indexPlayback, Playback, type DayData, type Stay } from './playback';
import type { DayRequestInput, WorkerReply, WorkerRequest } from './dayWorker';

export type EngineInput = DayRequestInput;
type RequestBody = WorkerRequest extends infer R ? R extends unknown ? Omit<R, 'id'> : never : never;
export interface PreparedDay { key: string; playback: Playback; day: DecodedDay; info: DayInfo; prepareMs: number; outdoorStays: Stay[] }

type Scheduler = { postTask(task: () => void, options: { priority: 'background' | 'user-visible' }): Promise<void> };
/** Yield to the event loop (a fresh task, so the browser can draw a frame in between). */
const yieldTask = (): Promise<void> => new Promise(resolve => {
  const scheduler = (globalThis as unknown as { scheduler?: Scheduler }).scheduler;
  if (scheduler?.postTask) void scheduler.postTask(resolve, { priority: 'user-visible' });
  else { const channel = new MessageChannel(); channel.port1.onmessage = () => resolve(); channel.port2.postMessage(null); }
});

/** Slice budget: a 60 FPS frame leaves several free milliseconds; take at most this much at a time. */
const SLICE_MS = 4;

/** Run resumable steps in short background tasks between frames (at least one step per task). */
export async function runSliced<T>(steps: Generator<void, T>, current: () => boolean): Promise<T | undefined> {
  for (;;) {
    await yieldTask();
    if (!current()) return undefined;
    const until = performance.now() + SLICE_MS;
    do {
      const step = steps.next();
      if (step.done) return step.value;
    } while (performance.now() < until);
  }
}

export class DayEngine {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (reply: WorkerReply) => void }>();
  private readonly cache = new Map<string, PreparedDay>();
  private generation = 0;
  readonly ready: Promise<number>;
  failed: string | null = null;

  private readonly base: DayData;
  private readonly calendar: AcademicCalendar | undefined;
  private readonly keep: number;

  constructor(base: DayData, calendar: AcademicCalendar | undefined, keep = 2) {
    this.base = base; this.calendar = calendar; this.keep = keep;
    this.worker = new Worker(new URL('./dayWorker.ts', import.meta.url), { type: 'module' });
    let markReady: (students: number) => void, markFailed: (error: Error) => void;
    this.ready = new Promise((resolve, reject) => { markReady = resolve; markFailed = reject; });
    this.ready.catch(() => undefined);
    this.worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data;
      if (reply.type === 'ready') { markReady(reply.students); return; }
      if (reply.type === 'error' && reply.id === null) { this.failed = reply.message; markFailed(new Error(reply.message)); return; }
      if (reply.id === null) return;
      const waiter = this.waiting.get(reply.id);
      if (waiter) { this.waiting.delete(reply.id); waiter.resolve(reply); }
    };
    this.worker.onerror = (event) => { this.failed = event.message || 'Day worker failed'; markFailed(new Error(this.failed)); };
  }

  private send(request: RequestBody): Promise<WorkerReply> {
    const id = this.nextId++;
    return new Promise(resolve => { this.waiting.set(id, { resolve }); this.worker.postMessage({ ...request, id }); });
  }

  /** Same key the worker's day cache uses for the conditions (the model is fixed per page load). */
  keyFor(weekday: number, input: EngineInput): string {
    return `${weekday}:${input.eventDate ?? 'baseline'}|${conditionsKey(conditionsFor({ ...input, weekday, calendar: this.calendar }))}`;
  }

  /** The newest request wins; resolves undefined when superseded. */
  async requestDay(weekday: number, input: EngineInput): Promise<PreparedDay | undefined> {
    const generation = ++this.generation;
    const key = this.keyFor(weekday, input);
    const cached = this.cache.get(key);
    if (cached) { this.cache.delete(key); this.cache.set(key, cached); return cached; }
    await this.ready;
    const reply = await this.send({ type: 'build', weekday, input });
    if (reply.type === 'error') throw new Error(reply.message);
    if (reply.type !== 'day' || generation !== this.generation) return undefined;
    const started = performance.now();
    const current = () => generation === this.generation;
    const data = await runSliced(decodeDaySteps(reply.encoded as EncodedDay, this.base), current);
    if (!data) return undefined;
    const index = await runSliced(indexPlayback(data), current);
    if (!index) return undefined;
    const outdoorStays = (data.stays ?? []).filter(stay => stay.location.startsWith('outdoor:'));
    const prepared: PreparedDay = { key, playback: new Playback(data, index), day: data, info: reply.info, prepareMs: performance.now() - started, outdoorStays };
    this.cache.set(key, prepared);
    while (this.cache.size > this.keep) this.cache.delete(this.cache.keys().next().value!);
    return prepared;
  }

  async compare(weekday: number, input: EngineInput, baseline: EngineInput): Promise<DayComparison> {
    await this.ready;
    const reply = await this.send({ type: 'compare', weekday, input, baseline });
    if (reply.type === 'error') throw new Error(reply.message);
    if (reply.type !== 'compare') throw new Error('Comparison was superseded');
    return reply.comparison;
  }

  dispose() { this.worker.terminate(); }
}
