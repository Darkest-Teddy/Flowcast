// Student fatigue model.
//
// A stated-assumption model, not a fitted one. It combines three parts:
//   1. Sleep pressure (process S of Borbély's two-process model): rises toward 1 while awake.
//   2. Circadian rhythm (process C): a 24 h cosine that lowers fatigue in the late afternoon
//      and raises it in the early morning.
//   3. Activity load: each hour spent in class, the library or the gym adds load; meals and
//      time in the dorm shed it. Rushing between back-to-back items at different places adds
//      a fixed penalty. Load decays exponentially between items.
//
// The constants below are the assumptions. Change them here, not at call sites.

import type { CampusLocation, LocationKind, ScheduleItem } from '../data/types';

export const FATIGUE_ASSUMPTIONS = {
  /** Hours for sleep pressure to rise ~63% of the way to 1 while awake (Borbély/Daan). */
  pressureRiseHours: 18.2,
  /** Sleep pressure on waking after a normal night. */
  pressureOnWake: 0.15,
  /** Peak-to-mean amplitude of the circadian term. */
  circadianAmplitude: 0.1,
  /** Hour of day (local, 0-24) when the circadian term makes you least tired. */
  circadianAlertPeakHour: 17,
  /** Load added (or removed, if negative) per hour spent at each kind of place. */
  loadPerHour: {
    classroom: 0.08,
    library: 0.06,
    gym: 0.12,
    venue: 0.04,
    dining: -0.05,
    dorm: -0.03,
  } satisfies Record<LocationKind, number>,
  /** Hours for accumulated load to fall to ~37% when nothing else is happening. */
  loadDecayHours: 3,
  /** Gap, in minutes, below which moving between two different places counts as a rush. */
  rushGapMinutes: 15,
  /** Load added per rushed transition. */
  rushPenalty: 0.03,
  /** Load at which the load term saturates at 1. About three straight hours of class. */
  loadSaturation: 0.25,
  /** Weights for combining the three parts into one 0-1 score. */
  weights: { pressure: 0.6, load: 0.4 },
} as const;

export type FatigueAssumptions = typeof FATIGUE_ASSUMPTIONS;

export interface FatigueSample {
  at: string; // ISO
  /** Combined fatigue, clamped to 0-1. */
  score: number;
  pressure: number;
  circadian: number;
  load: number;
  /** Schedule item the student is in at this moment, if any. */
  itemId?: string;
}

export interface FatigueOptions {
  /** When the student woke up. The curve starts here. */
  wakeAt: string;
  /** When the curve ends. */
  until: string;
  stepMinutes?: number;
  /** Hour-of-day offset from UTC for the circadian term. Boston in October is -4. */
  utcOffsetHours?: number;
  assumptions?: FatigueAssumptions;
}

export interface FatigueSummary {
  samples: FatigueSample[];
  peak: FatigueSample | null;
  /** Mean score over the waking day. */
  mean: number;
  /** Count of rushed transitions found in the schedule. */
  rushes: number;
}

const HOUR_MS = 3_600_000;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function sleepPressure(hoursAwake: number, a: FatigueAssumptions = FATIGUE_ASSUMPTIONS): number {
  const s0 = a.pressureOnWake;
  return 1 - (1 - s0) * Math.exp(-Math.max(0, hoursAwake) / a.pressureRiseHours);
}

/** Positive when the body clock adds fatigue, negative when it removes it. */
export function circadian(hourOfDay: number, a: FatigueAssumptions = FATIGUE_ASSUMPTIONS): number {
  return -a.circadianAmplitude * Math.cos((2 * Math.PI * (hourOfDay - a.circadianAlertPeakHour)) / 24);
}

export function modelFatigue(
  items: ScheduleItem[],
  locations: CampusLocation[],
  options: FatigueOptions,
): FatigueSummary {
  const a = options.assumptions ?? FATIGUE_ASSUMPTIONS;
  const stepMs = (options.stepMinutes ?? 15) * 60_000;
  const offsetMs = (options.utcOffsetHours ?? 0) * HOUR_MS;
  const wake = Date.parse(options.wakeAt);
  const until = Date.parse(options.until);
  if (!Number.isFinite(wake) || !Number.isFinite(until)) throw new Error('modelFatigue: wakeAt and until must be ISO dates');
  if (until <= wake) return { samples: [], peak: null, mean: 0, rushes: 0 };
  if (stepMs <= 0) throw new Error('modelFatigue: stepMinutes must be positive');

  const kindById = new Map(locations.map((l) => [l.id, l.kind]));
  const timed = items
    .filter((i) => i.source !== 'suggested' || i.accepted)
    .map((i) => ({ item: i, start: Date.parse(i.start), end: Date.parse(i.end) }))
    .filter((i) => Number.isFinite(i.start) && i.end > i.start)
    .sort((x, y) => x.start - y.start);

  // Rushed transitions become one-off load bumps at the start of the later item.
  const bumps: number[] = [];
  for (let k = 1; k < timed.length; k++) {
    const prev = timed[k - 1];
    const next = timed[k];
    const gapMin = (next.start - prev.end) / 60_000;
    if (gapMin >= 0 && gapMin < a.rushGapMinutes && prev.item.locationId !== next.item.locationId) {
      bumps.push(next.start);
    }
  }

  const samples: FatigueSample[] = [];
  let load = 0;
  let bumpIdx = 0;
  const decayPerStep = Math.exp(-stepMs / HOUR_MS / a.loadDecayHours);

  for (let t = wake; t <= until; t += stepMs) {
    // Overlapping items add their rates. Items at unknown locations contribute nothing.
    const activeAt = (when: number) => timed.filter((i) => i.start <= when && when < i.end);
    const current = activeAt(t).find((i) => kindById.has(i.item.locationId));
    if (t > wake) {
      // Rate over the step that ends at t, taken at its midpoint.
      const rate = activeAt(t - stepMs / 2).reduce((r, i) => {
        const kind = kindById.get(i.item.locationId);
        return kind ? r + a.loadPerHour[kind] : r;
      }, 0);
      // Exact step of dL/dt = rate - L / decayHours, so results don't depend on stepMinutes.
      load = load * decayPerStep + rate * a.loadDecayHours * (1 - decayPerStep);
    }
    while (bumpIdx < bumps.length && bumps[bumpIdx] <= t) {
      load += a.rushPenalty;
      bumpIdx++;
    }
    load = Math.max(0, load);

    const pressure = sleepPressure((t - wake) / HOUR_MS, a);
    const hourOfDay = ((((t + offsetMs) / HOUR_MS) % 24) + 24) % 24;
    const c = circadian(hourOfDay, a);
    const score = clamp01(a.weights.pressure * pressure + a.weights.load * clamp01(load / a.loadSaturation) + c);

    samples.push({
      at: new Date(t).toISOString(),
      score,
      pressure,
      circadian: c,
      load,
      ...(current ? { itemId: current.item.id } : {}),
    });
  }

  const peak = samples.reduce<FatigueSample | null>((best, s) => (!best || s.score > best.score ? s : best), null);
  const mean = samples.reduce((sum, s) => sum + s.score, 0) / samples.length;
  return { samples, peak, mean, rushes: bumps.length };
}
