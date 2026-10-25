// Builds simulated days on a worker thread so the API keeps answering while one builds. Each day is
// several seconds of solid CPU; built on the main thread, every request waited behind it, and the
// host (serve.mjs) gave up after 30 s with a 503. The thread (dayWorker.thread.ts) loads the same
// sources and sends back each day's compact form, which is plain data. It exits when idle, so its
// copy of the sources isn't kept in memory between builds.

import { Worker } from 'node:worker_threads';
import type { CompactDayData } from './compactDay';

/** How long the thread stays loaded after its last build. Prebuilding the week keeps it busy throughout. */
const IDLE_MS = 30_000;

export interface DayRequest { id: number; weekday: number }
export interface DayReply { id: number; data?: CompactDayData | null; error?: string }

export class DayWorker {
  private worker: Worker | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (data: CompactDayData | null) => void; reject: (error: Error) => void }>();
  private idle: NodeJS.Timeout | undefined;

  constructor(private readonly bundlePath: string) {}

  /** The day's compact data, or null when it needs the full Playback (compactDay.ts). */
  build(weekday: number): Promise<CompactDayData | null> {
    clearTimeout(this.idle);
    const worker = this.worker ?? this.start();
    worker.ref();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, weekday } satisfies DayRequest);
    });
  }

  private start(): Worker {
    // The thread inherits this process's flags: the tsx loader and the heap cap (serve.mjs).
    const worker = new Worker(new URL('./dayWorker.thread.ts', import.meta.url), { workerData: { bundlePath: this.bundlePath } });
    worker.on('message', (reply: DayReply) => {
      const call = this.pending.get(reply.id);
      this.pending.delete(reply.id);
      if (reply.error !== undefined) call?.reject(new Error(reply.error));
      else call?.resolve(reply.data ?? null);
      if (this.pending.size === 0) this.rest(worker);
    });
    const fail = (error: Error) => {
      if (this.worker !== worker) return;
      this.worker = null;
      for (const call of this.pending.values()) call.reject(error);
      this.pending.clear();
    };
    worker.on('error', fail);
    worker.on('exit', (code) => fail(new Error(`day worker exited with code ${code}`)));
    this.worker = worker;
    return worker;
  }

  /** Lets the process exit while the thread is idle, and ends the thread if it stays idle. */
  private rest(worker: Worker) {
    worker.unref();
    this.idle = setTimeout(() => {
      if (this.worker !== worker) return;
      this.worker = null;
      void worker.terminate();
    }, IDLE_MS);
    this.idle.unref();
  }
}
