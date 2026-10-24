// Traffic-signal phases on the app clock (seconds since midnight), so Live runs in real time and
// fast-forward speeds the lights up with everything else.
//
// Boston doesn't publish live signal states (there is no open SPaT feed), so each intersection
// runs a fixed-time plan by time of day (AM peak, midday, PM peak, evening, night) from
// data-pipeline/fetch_street.py (street.json `intersections`). Along Comm Ave at BU the plans
// are the published BTD timings from BU's 2013 Transportation Master Plan (2012 Synchro sheets:
// cycle, splits and offsets, so the corridor keeps its real coordination); elsewhere they are
// defaults built from BTD's 2023 Signal Operations Design Policy and MUTCD / ITE practice.
// Each intersection's `source` says which. An old street.json without plans falls back to a
// hashed 60-90 s two-phase plan.

export type Lamp = 'red' | 'amber' | 'green';

/**
 * One movement's green window in the cycle. The approaches it applies to are named by
 * `moves` (compass movements, "EB", "SW"...) when the plan comes from a published sheet, and
 * by `axis` (0 main road, 1 crossing road) otherwise or for approaches the sheet doesn't name.
 * No moves and no axis: a pedestrian-only interval, all vehicles held.
 */
export interface Split {
  moves?: string[];
  axis?: 0 | 1;
  label?: string;
  start: number; // seconds into the cycle the window opens (may wrap past the cycle end)
  lpi?: number; // leading pedestrian interval: WALK shows, these vehicles still held
  green: number;
  yellow: number;
  allRed: number;
  walk?: number; // pedestrians crossing alongside: WALK, then flashing DON'T WALK
  fdw?: number;
}

export interface TimingPlan {
  name: string; // "AM peak", "Midday", ...
  from: number; // seconds since midnight, inclusive
  to: number; // exclusive; may be past 86400 to wrap midnight
  cycle: number;
  offset: number; // seconds: the cycle (start 0) begins at time ≡ offset (mod cycle)
  note?: string; // e.g. "published AM plan reused: no published midday plan"
  splits: Split[];
}

export interface IntersectionTiming {
  group: string;
  name: string;
  source: string; // shown in the tooltip, e.g. "typical Boston arterial (no published plan)"
  sourceUrl?: string;
  published: 'full' | 'cycle' | 'none'; // what came from a published document
  node?: number | null; // Synchro node number in the BU sheets
  corridor?: string;
  plans: TimingPlan[];
}

// --------------------------------------------------------------------------------------------
// Registry: street.ts registers the loaded street.json; transit motion reads it.
// --------------------------------------------------------------------------------------------

export interface SignalApproach {
  id: string;
  group: string;
  axis: 0 | 1;
  movement?: string; // "EB", "WB"... when the intersection has a published plan
  /** Where traffic on this approach stops: [lng, lat] on the stop line, and its travel bearing. */
  stopLine?: [number, number];
  approach?: number;
  flash?: boolean;
}

let timings = new Map<string, IntersectionTiming>();
let approaches: SignalApproach[] = [];
let version = 0;

export function registerSignals(list: SignalApproach[], intersections: IntersectionTiming[] = []) {
  approaches = list;
  timings = new Map(intersections.map((i) => [i.group, i]));
  version++;
}

export function registeredSignals(): { approaches: SignalApproach[]; version: number } {
  return { approaches, version };
}

export function timingFor(group: string): IntersectionTiming | undefined {
  return timings.get(group);
}

// --------------------------------------------------------------------------------------------
// Plans
// --------------------------------------------------------------------------------------------

const DAY = 86_400;

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

const fallbackPlans = new Map<string, TimingPlan>();

/** The old hashed plan, for intersections street.json has no timing for. */
function fallbackPlan(group: string): TimingPlan {
  let plan = fallbackPlans.get(group);
  if (!plan) {
    const h = hash(group);
    const cycle = 60 + (h % 31); // 60-90 s
    const main = Math.round(cycle * 0.45);
    plan = {
      name: 'Default',
      from: 0,
      to: DAY,
      cycle,
      offset: (((h >>> 8) % 1000) / 1000) * cycle,
      splits: [
        { axis: 0, start: 0, green: main, yellow: 4, allRed: 2 },
        { axis: 1, start: main + 6, green: cycle - main - 12, yellow: 4, allRed: 2 },
      ],
    };
    fallbackPlans.set(group, plan);
  }
  return plan;
}

const inPlan = (p: TimingPlan, tod: number) => (tod >= p.from && tod < p.to) || (tod + DAY >= p.from && tod + DAY < p.to);

/** The plan running at `time` (seconds since midnight) at an intersection. */
export function planAt(time: number, group: string): TimingPlan {
  const t = timings.get(group);
  if (!t || !t.plans.length) return fallbackPlan(group);
  const tod = ((time % DAY) + DAY) % DAY;
  return t.plans.find((p) => inPlan(p, tod)) ?? t.plans[0];
}

const mod = (x: number, m: number) => ((x % m) + m) % m;

/** Does this split govern an approach with this axis / movement? */
export function splitApplies(s: Split, axis: number, movement?: string): boolean {
  if (movement !== undefined && s.moves) return s.moves.includes(movement);
  return s.axis !== undefined && s.axis === axis;
}

/**
 * Which lamp an approach shows at `time` (seconds since midnight). `axis` 0 is the main road,
 * 1 the crossing road; `movement` ("EB"...) picks the approach out in a published plan.
 * Flashing signals blink amber once a second (null while dark).
 */
export function lampAt(time: number, group: string, axis: number, flash = false, movement?: string): Lamp | null {
  if (flash) return time % 1 < 0.5 ? 'amber' : null;
  const plan = planAt(time, group);
  const u = mod(time - plan.offset, plan.cycle);
  let lamp: Lamp = 'red';
  let matched = false;
  for (const s of plan.splits) {
    if (!splitApplies(s, axis, movement)) continue;
    matched = true;
    const w = mod(u - s.start, plan.cycle);
    const lpi = s.lpi ?? 0;
    if (w < lpi) continue;
    if (w < lpi + s.green) return 'green';
    if (w < lpi + s.green + s.yellow) lamp = 'amber';
  }
  // An approach a published plan doesn't name (a driveway, a ramp) runs with its axis.
  if (!matched && movement !== undefined) return lampAt(time, group, axis, false, undefined);
  return lamp;
}

/** Seconds until this approach's lamp next changes (from `time`), for the tooltip. */
export function secondsToChange(time: number, group: string, axis: number, movement?: string): number {
  const now = lampAt(time, group, axis, false, movement);
  for (let dt = 0.25; dt < 300; dt += 0.25) if (lampAt(time + dt, group, axis, false, movement) !== now) return dt;
  return 0;
}

/** Seconds from `time` until this approach next shows green (0 if it is green now). */
export function secondsToGreen(time: number, group: string, axis: number, movement?: string): number {
  for (let dt = 0; dt < 300; dt += 0.25) if (lampAt(time + dt, group, axis, false, movement) === 'green') return dt;
  return 300;
}

/** The split that gives this approach its green, for the tooltip. */
export function splitFor(time: number, group: string, axis: number, movement?: string): Split | undefined {
  const splits = planAt(time, group).splits;
  return splits.find((s) => splitApplies(s, axis, movement)) ?? splits.find((s) => splitApplies(s, axis, undefined));
}

/** "Timing: Comm Ave corridor (BTD 2012 Synchro sheets), PM peak plan · 110 s cycle". */
export function timingLabel(time: number, group: string): string {
  const t = timings.get(group);
  if (!t) return 'Timing: simulated (no plan loaded)';
  const plan = planAt(time, group);
  const note = plan.note ? ` (${plan.note})` : '';
  return `Timing: ${t.source}, ${plan.name} plan${note} · ${Math.round(plan.cycle)} s cycle`;
}
