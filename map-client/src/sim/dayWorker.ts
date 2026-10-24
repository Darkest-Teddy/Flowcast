// The conditions engine's day builder, off the map's thread. Loads the same public data the map
// does, builds the same roster, and simulates conditioned days on request (a full Wednesday takes
// a couple of seconds). Days go back packed in typed arrays (sim/dayCodec.ts), by transfer.
import { loadCampusData, type CampusData } from '../data/campusData';
import { loadDay } from './playback';
import { buildPopulation, loadPopulation, type PopulationBase } from './population';
import { buildSourceDay, LEGACY_BEHAVIOR, type SourceDay } from './sourceDay';
import { dayBehavior, loadBehaviorModel, personaFor, type BehaviorModel } from './behavior';
import { conditionsFor, type ConditionsInput } from './conditions';
import { encodeDay, transferables } from './dayCodec';
import { compareDays } from './compare';
import type { DayInfo } from './explain';
import { createTransitService, mergeSchedules, type TransitService } from './transitService';
import { loadPublishedSchedule } from '../transit/publishedSchedule';

/** The conditions (without the calendar, which the worker has) and the date whose campus events play. */
export type DayRequestInput = Omit<ConditionsInput, 'calendar'> & { eventDate: string | null };
export type WorkerRequest =
  | { type: 'build'; id: number; weekday: number; input: DayRequestInput }
  | { type: 'compare'; id: number; weekday: number; input: DayRequestInput; baseline: DayRequestInput };
export type WorkerReply =
  | { type: 'ready'; students: number }
  | { type: 'day'; id: number; encoded: ReturnType<typeof encodeDay>; info: DayInfo }
  | { type: 'compare'; id: number; comparison: ReturnType<typeof compareDays> }
  | { type: 'skipped'; id: number }
  | { type: 'error'; id: number | null; message: string };

const scope = self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void; onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null };
const post = (reply: WorkerReply, transfer: Transferable[] = []) => scope.postMessage(reply, transfer);

let state: { base: PopulationBase; data: CampusData; model: BehaviorModel; personaMix: DayInfo['personaMix']; transit: TransitService | undefined } | null = null;
const loading = (async () => {
  // Same sources as the map (App.tsx): students ride published MBTA and BU Shuttle trips when the timetables load.
  const shuttle = loadPublishedSchedule('/data/shuttle-schedule.json').catch(() => null);
  const [day, data, population, model, mbta] = await Promise.all([loadDay('/data/demo-day.json'), loadCampusData(), loadPopulation(), loadBehaviorModel(),
    loadPublishedSchedule().catch(() => null)]);
  const shuttleSchedule = await shuttle;
  const timetable = mbta ? mergeSchedules(mbta, shuttleSchedule) : shuttleSchedule;
  const transit = timetable ? createTransitService(timetable) : undefined;
  const base = buildPopulation(day, data, population);
  const counts = new Map<string, number>();
  for (const agent of base.agents) { const persona = personaFor(agent, model.personas) ?? 'typical'; counts.set(persona, (counts.get(persona) ?? 0) + 1); }
  const personaMix = [...counts].map(([id, students]) => ({ id, label: model.personas?.personas.find(row => row.id === id)?.label ?? id, students }));
  state = { base, data, model, personaMix, transit };
  post({ type: 'ready', students: base.agents.length });
})().catch((error: Error) => post({ type: 'error', id: null, message: `Day worker could not load data: ${error.message}` }));

function build(weekday: number, { eventDate, ...input }: DayRequestInput): { day: SourceDay; info: DayInfo; key: string } {
  const { base, data, model, personaMix, transit } = state!;
  const conditions = conditionsFor({ ...input, weekday, calendar: data.academicCalendar });
  const behavior = dayBehavior(conditions, model, LEGACY_BEHAVIOR);
  const started = performance.now();
  const day = buildSourceDay(base, data, weekday, transit, { eventDate, conditions, model });
  const buildMs = performance.now() - started;
  const visits: Record<string, number> = {};
  for (const activity of day.sourceActivities) {
    const kind = { dining: 'dining hall meals', library: 'library visits', gym: 'gym visits', outdoor: 'visits by the river', 'off-campus-outing': 'outings',
      'off-campus-meal': 'meals off campus', gathering: 'event attendances' }[activity.kind as string];
    if (kind) visits[kind] = (visits[kind] ?? 0) + 1;
  }
  visits['class attendances'] = day.sourceAssignments.length;
  let outdoorPeak = { count: 0, hour: 12 };
  const outdoor = (day.stays ?? []).filter(stay => stay.location.startsWith('outdoor:'));
  for (let hour = 6; hour < 24; hour += 0.5) {
    const time = hour * 3600;
    let count = 0;
    for (const stay of outdoor) if (stay.start <= time && time < stay.end) count++;
    if (count > outdoorPeak.count) outdoorPeak = { count, hour };
  }
  const validation = model.behavior?.validation as DayInfo['validation'];
  const info: DayInfo = { key: behavior.key, conditions, active: behavior.active, personaMix, students: base.agents.length, validation, buildMs, visits, outdoorPeak };
  if (day.transitRides.length) visits['transit rides'] = day.transitRides.length;
  return { day, info, key: `${weekday}:${eventDate ?? 'baseline'}|${behavior.key}` };
}

// Requests are coalesced: only the newest day request runs; older ones are answered "skipped".
const pending: WorkerRequest[] = [];
let scheduled = false;
const schedule = () => { if (!scheduled && pending.length) { scheduled = true; setTimeout(run, 0); } };
function run() {
  scheduled = false;
  const latestBuild = [...pending].reverse().find(row => row.type === 'build');
  for (const row of pending.filter(row => row.type === 'build' && row !== latestBuild)) post({ type: 'skipped', id: row.id });
  const job = latestBuild ?? pending.find(row => row.type === 'compare');
  pending.splice(0, pending.length, ...pending.filter(row => row.type === 'compare' && row !== job));
  if (!job) return;
  try {
    if (job.type === 'build') {
      const { day, info, key } = build(job.weekday, job.input);
      const encoded = encodeDay(day, state!.base, key);
      post({ type: 'day', id: job.id, encoded, info }, transferables(encoded));
    } else {
      const scenario = build(job.weekday, job.input).day, baseline = build(job.weekday, job.baseline).day;
      const names = Object.fromEntries((state!.model.outdoor?.spots ?? []).map(spot => [spot.id, spot.name]));
      post({ type: 'compare', id: job.id, comparison: compareDays(baseline, scenario, state!.base, names) });
    }
  } catch (error) {
    post({ type: 'error', id: job.id, message: (error as Error).message });
  }
  schedule();
}

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  pending.push(event.data);
  void loading.then(schedule);
};

