import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import type { CampusLocation, ScheduleImportState, SchedulePreview } from '../../../web/src/data/types';

export const MAX_CALENDAR_BYTES = 1024 * 1024;
export const MAX_SCHEDULE_ITEMS = 2000;
export class ScheduleError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const fileName = z.string().trim().min(1).max(255).regex(/^[^\x00-\x1f/\\]+\.ics$/i);
export const previewRequest = z.object({ fileName, content: z.string().min(1).max(MAX_CALENDAR_BYTES) }).strict();
const timestamp = z.iso.datetime({ offset: true }).refine((s) => Number.isFinite(Date.parse(s)));
export const scheduleRequest = z.object({
  fileName,
  items: z.array(z.object({
    id: z.string().min(1).max(200), title: z.string().trim().min(1).max(300),
    locationId: z.string().max(160), locationText: z.string().max(1000).optional(),
    start: timestamp, end: timestamp, source: z.literal('calendar'),
  }).strict()).max(MAX_SCHEDULE_ITEMS),
}).strict();

function bostonMidnight(day: string) {
  const utc = Date.parse(`${day}T00:00:00Z`);
  // Boston's offset at local midnight is the offset at 04:00 UTC, including transition days.
  const offset = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })
    .formatToParts(new Date(utc + 4 * 3600000)).find((p) => p.type === 'timeZoneName')!.value;
  return new Date(utc - Number(offset.replace('GMT', '')) * 3600000).toISOString();
}
export function scheduleWindow(now = new Date()) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const end = new Date(`${day}T12:00:00Z`); end.setUTCDate(end.getUTCDate() + 120);
  return { windowStart: bostonMidnight(day), windowEnd: bostonMidnight(end.toISOString().slice(0, 10)) };
}
export function validateSchedule(input: unknown, locations: Pick<CampusLocation, 'id'>[], now = new Date()) {
  const parsed = scheduleRequest.safeParse(input);
  if (!parsed.success) throw new ScheduleError('Invalid schedule fields; import at most 2,000 calendar items from an .ics file.');
  const window = scheduleWindow(now);
  const ids = new Set<string>(); const known = new Set(locations.map((l) => l.id));
  for (const item of parsed.data.items) {
    const start = Date.parse(item.start); const end = Date.parse(item.end);
    if (ids.has(item.id)) throw new ScheduleError('Schedule item IDs must be unique.');
    ids.add(item.id);
    if (item.locationId !== '' && !known.has(item.locationId)) throw new ScheduleError('Unknown campus location.');
    if (start < Date.parse(window.windowStart) || start >= Date.parse(window.windowEnd) || end <= start || end - start > 7 * 86400000) {
      throw new ScheduleError('Schedule starts must fall within the next 120 Boston days; durations must be positive and at most seven days.');
    }
    item.start = new Date(start).toISOString(); item.end = new Date(end).toISOString();
  }
  return { ...parsed.data, ...window };
}
export const emptySchedule = (): ScheduleImportState => ({ items: [], fileName: null, importedAt: null, windowStart: null, windowEnd: null });
export function scheduleState(row: { schedule: ScheduleImportState['items']; schedule_import: Omit<ScheduleImportState, 'items'> | null }): ScheduleImportState {
  return { ...emptySchedule(), ...row.schedule_import, items: row.schedule };
}

let activeWorkers = 0;
export async function previewSchedule(input: unknown, locations: Pick<CampusLocation, 'id' | 'name' | 'short'>[], now = new Date()): Promise<SchedulePreview> {
  const parsed = previewRequest.safeParse(input);
  if (!parsed.success) throw new ScheduleError('Send an .ics file name and calendar content of at most 1 MiB.');
  if (Buffer.byteLength(parsed.data.content, 'utf8') > MAX_CALENDAR_BYTES) throw new ScheduleError('Calendar files must be at most 1 MiB.', 413);
  if (activeWorkers >= 2) throw new ScheduleError('Calendar preview is busy. Please try again shortly.', 429);
  const window = scheduleWindow(now);
  activeWorkers++;
  try {
    const result = await new Promise<{ items: SchedulePreview['items']; warnings: string[] }>((resolve, reject) => {
      const worker = new Worker(new URL('./schedule-worker.mjs', import.meta.url), {
        workerData: { content: parsed.data.content, locations, ...window, maxItems: MAX_SCHEDULE_ITEMS },
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 }, stdout: true, stderr: true,
      });
      // Library diagnostics can contain private calendar text. Drain without forwarding them.
      worker.stdout.resume(); worker.stderr.resume();
      const timeout = setTimeout(() => { void worker.terminate(); reject(new ScheduleError('Calendar is too complex to expand. Simplify its recurrence rules.')); }, 3000);
      worker.once('message', (message) => {
        clearTimeout(timeout); void worker.terminate();
        if (message.error) reject(new ScheduleError(message.error)); else resolve(message);
      });
      worker.once('error', () => { clearTimeout(timeout); reject(new ScheduleError('Calendar could not be processed within its resource limits.')); });
      worker.once('exit', (code) => { clearTimeout(timeout); if (code !== 0) reject(new ScheduleError('Calendar processing stopped before completion.')); });
    });
    const validated = validateSchedule({ fileName: parsed.data.fileName, items: result.items }, locations, now);
    return { ...validated, warnings: result.warnings };
  } finally { activeWorkers--; }
}
