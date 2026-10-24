// Simulated traffic-signal phases. Boston doesn't publish live signal timing, so each
// intersection runs a plausible fixed-time plan: a 60-90 s cycle, main road green ~45%, 4 s
// amber, 2 s all-red, then the crossing road gets the rest. Crossing approaches alternate (one
// axis green while the other is red) and each intersection has its own offset, so the city
// doesn't flip in unison. Driven by the app clock (seconds since midnight), so Live mode runs in
// real time and fast-forward speeds the lights up with everything else.

export type Lamp = 'red' | 'amber' | 'green';

export const AMBER_SECONDS = 4;
export const ALL_RED_SECONDS = 2;
const MAIN_GREEN_SHARE = 0.45;

export interface SignalPlan {
  cycle: number; // seconds
  offset: number; // seconds
  mainGreen: number; // seconds of green for axis 0
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

const plans = new Map<string, SignalPlan>();

/** The fixed-time plan for an intersection, stable for its id. */
export function planFor(group: string): SignalPlan {
  let plan = plans.get(group);
  if (!plan) {
    const h = hash(group);
    const cycle = 60 + (h % 31); // 60-90 s
    plan = { cycle, offset: ((h >>> 8) % 1000) / 1000 * cycle, mainGreen: Math.round(cycle * MAIN_GREEN_SHARE) };
    plans.set(group, plan);
  }
  return plan;
}

/**
 * Which lamp an approach shows at `time` (seconds since midnight). `axis` 0 is the main road,
 * 1 the crossing road. Flashing signals blink amber once a second (null while dark).
 */
export function lampAt(time: number, group: string, axis: number, flash = false): Lamp | null {
  if (flash) return time % 1 < 0.5 ? 'amber' : null;
  const { cycle, offset, mainGreen } = planFor(group);
  const u = (((time + offset) % cycle) + cycle) % cycle;
  // Axis 0: green, amber, then red. Axis 1 starts after the all-red and ends with its own.
  const start = axis === 0 ? 0 : mainGreen + AMBER_SECONDS + ALL_RED_SECONDS;
  const green = axis === 0 ? mainGreen : cycle - start - AMBER_SECONDS - ALL_RED_SECONDS;
  const t = u - start;
  if (t >= 0 && t < green) return 'green';
  if (t >= green && t < green + AMBER_SECONDS) return 'amber';
  return 'red';
}

/** Seconds until this approach's lamp next changes, for the tooltip. */
export function secondsToChange(time: number, group: string, axis: number): number {
  const now = lampAt(time, group, axis);
  for (let dt = 0.5; dt < 120; dt += 0.5) if (lampAt(time + dt, group, axis) !== now) return dt;
  return 0;
}
