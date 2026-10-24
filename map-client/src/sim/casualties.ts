// Illustrative injuries and fatalities for modeled fire, earthquake and meteor scenarios.
// A pure post-process over a complete, already transformed day timeline: no Math.random, no clock.
// Values are uncalibrated what-if illustrations, not clinical or real-world casualty predictions.
import type { CampusLocation, DayData, Stay, Trip } from './playback';
import type { DisasterKind } from './disasters';

/** One terminal outcome per agent. An injured person is incapacitated for the rest of the day (no treatment or recovery is modeled). */
export type CasualtyEvent = {
  agentId: string;
  outcome: 'injured' | 'fatality';
  /** Sim second (since midnight) the harm happens. */
  at: number;
  /** Where the person is at `at`, [lng, lat]. */
  position: [number, number];
  cause: 'fire' | 'earthquake' | 'meteor';
  /** Damaged building the person was inside, when the harm happened indoors. */
  buildingId?: string;
};

import { DAMAGE_ASSUMPTIONS, damageAt, damageCurves, damageSeed, type BuildingDamageFrame } from './disasterDamage';

/**
 * Illustrative, uncalibrated exposure constants. Each person accumulates a harm score from their own
 * modeled positions; the first moment it reaches a fixed per-person threshold is their single event.
 * The threshold and the injury/fatality split come from a stable hash of person, kind, start and target.
 */
export const CASUALTY_ASSUMPTIONS = {
  fire: {
    /** Harm builds while inside the burning building during the active fire: rate = growthPerSecond2 ×
     * seconds of this continuous stay inside since ignition (or since entering, if later). Inside 60 s
     * scores ≈ 0.01; still inside after 10 minutes reaches 1. A brief walk through scores almost nothing. */
    growthPerSecond2: 5.6e-6,
    /** Fatality share of an event: base, plus collapseShare × the building's current collapse progress. */
    fatalityShareBase: 0.05, fatalityShareCollapse: 0.6,
    /** Walk positions are checked against the burning footprint every this many seconds. */
    walkSampleSeconds: 1,
  },
  earthquake: {
    /** Indoors at the building's modeled collapse midpoint: indoorBase × severity + collapseHarm × final collapse. */
    indoorBase: 0.04, collapseHarm: 0.5,
    /** Outdoors within the radius at the middle of the shaking: outdoorHarm × (1 − distance / radius); fatality share is the base. */
    outdoorHarm: 0.02,
    fatalityShareBase: 0.05, fatalityShareCollapse: 0.5,
  },
  meteor: {
    /** Indoors when the impact front reaches the building: indoorBase × severity + collapseHarm × final collapse. */
    indoorBase: 0.3, collapseHarm: 0.7,
    /** Outdoors within the radius when the front arrives: outdoorHarm × the damage model's severity at that distance. */
    outdoorHarm: 0.8,
    fatalityShareBase: 0.15, fatalityShareCollapse: 0.6,
  },
} as const;

export const CASUALTY_LIMITATIONS = [
  'Casualties are applied after evacuation planning. Their movement stops at the event, but exit queues, venue reservations and other agents’ plans are not recalculated.',
  'Injuries and fatalities are uncalibrated, illustrative what-if outcomes of a modeled scenario. They are not a clinical, structural or real-world casualty prediction for BU or any population, and no injury severity, treatment, rescue or recovery is modeled.',
  'Each person has at most one event. An injured person is shown as incapacitated where the harm happened for the rest of the simulated day; nobody is moved to a hospital or shelter.',
  'Exposure uses only the modeled positions in the scenario timeline up to the moment of harm, never later schedule entries. Fire harm grows with time spent inside the burning building between ignition and the end of the active fire, so leaving sooner lowers it. Earthquake harm happens at each damaged building’s modeled collapse and, outdoors within the radius, at the middle of the shaking. Meteor harm happens when the modeled impact front arrives.',
  'Only people inside a damaged building footprint or in the open within the hazard radius are exposed. Off-campus time, people outside the zone, drills and building closures never produce events.',
  'Outcomes are deterministic: a stable hash of person, scenario kind, start time and target picks each person’s threshold and injury/fatality split, so the same scenario always shows the same people.',
] as const;

export interface CasualtyScenario {
  kind: DisasterKind;
  start: number;
  /** End of the active fire, shaking or impact (IncidentHazard.activeUntil). Fire harm stops here. */
  activeUntil: number;
  target: CampusLocation;
  radiusMetres: number;
  affectedLocationIds: readonly string[];
  affectedBuildingIds: readonly string[];
}

const DAY = 86400;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const metres = (a: [number, number], b: [number, number]) => {
  const ky = 111320, kx = ky * Math.cos(a[1] * Math.PI / 180);
  return Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * ky);
};
function inside(point: [number, number], polygon: [number, number][]): boolean {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

type Item = { start: number; end: number; stay?: Stay; trip?: Trip };
type State = { location?: CampusLocation; point: [number, number] } | null;

function pointOnTrip(trip: Trip, t: number): [number, number] {
  const ts = trip.timestamps;
  let lo = 0, hi = ts.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ts[mid] <= t) lo = mid; else hi = mid; }
  const span = ts[hi] - ts[lo], f = span > 0 ? clamp01((t - ts[lo]) / span) : 1;
  const a = trip.path[lo], b = trip.path[hi];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

/** Illustrative casualties for one disaster. `day` must be the complete transformed (post-response) day. */
export function computeCasualties(day: DayData, scenario: CasualtyScenario): CasualtyEvent[] {
  const { kind, start, target, activeUntil } = scenario;
  const radius = scenario.radiusMetres;
  if (!Number.isFinite(start) || start < 0 || start >= DAY || !Number.isFinite(radius) || radius < 0
    || !Number.isFinite(activeUntil) || activeUntil <= start || activeUntil > DAY)
    throw new Error('Invalid casualty scenario');
  const locations = new Map(day.locations.map(location => [location.id, location]));
  // Final damage of every affected building (the same illustrative curves the map draws).
  const frames = new Map<string, BuildingDamageFrame>();
  for (const frame of damageAt({ incident: { kind, start }, hazard: { radiusMetres: radius, affectedBuildingIds: scenario.affectedBuildingIds },
    location: { position: target.position, building: target.building } }, DAY + start, day.buildings)) frames.set(frame.id, frame);
  const timelines = new Map<string, Item[]>(day.agents.map(agent => [agent.id, []]));
  for (const stay of day.stays ?? []) timelines.get(stay.agent)?.push({ start: stay.start, end: stay.end, stay });
  for (const trip of day.trips) timelines.get(trip.agent)?.push({ start: trip.timestamps[0], end: trip.timestamps.at(-1)!, trip });
  for (const items of timelines.values()) items.sort((a, b) => a.start - b.start || (a.trip ? 1 : 0) - (b.trip ? 1 : 0));

  const stateAt = (items: Item[], t: number): State => {
    let lo = 0, hi = items.length - 1, found = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (items[mid].start <= t) { found = mid; lo = mid + 1; } else hi = mid - 1; }
    // [start, end): at a boundary the next item applies; a zero-length tail falls back to the item that holds t.
    for (let i = found; i >= 0 && i >= found - 1; i--) {
      const item = items[i];
      if (!(item.start <= t && (t < item.end || item.end === DAY && t === DAY))) continue;
      if (item.trip) return { point: pointOnTrip(item.trip, t) };
      const location = locations.get(item.stay!.location);
      // Off-campus time has no modeled position on the map and is never exposed.
      if (!location || location.kind === 'off-campus' || location.id === 'off-campus') return null;
      return { location, point: location.position };
    }
    return null;
  };
  /** Damaged building the person is inside: their stay's building, or a footprint ring containing their walk position. */
  const buildingOf = (state: NonNullable<State>): BuildingDamageFrame | undefined => {
    if (state.location) return state.location.building ? frames.get(state.location.building) : undefined;
    for (const frame of frames.values()) if (frame.rings.some(ring => inside(state.point, ring))) return frame;
    return undefined;
  };
  /** In the open within the radius: a walk position outside every damaged footprint, or an outdoor
   * location. Indoor locations are sheltered by their own building unless it is damaged (buildingOf). */
  const inOpenZone = (state: NonNullable<State>) => radius > 0 && !buildingOf(state)
    && (!state.location || state.location.kind === 'outdoor' || !state.location.building)
    && metres(target.position, state.point) <= radius;

  type Pulse = { t: number; harm: number; fatality: number; buildingId?: string };
  const events: CasualtyEvent[] = [];
  const agentIds = [...timelines.keys()].sort(compare);
  const fire = CASUALTY_ASSUMPTIONS.fire;
  const fireFrame = kind === 'fire' && target.building ? frames.get(target.building) : undefined;
  const fireLocations = new Set(scenario.affectedLocationIds);
  const fireRings = fireFrame?.rings ?? [];
  const fireBox = fireRings.flat().reduce((box, [x, y]) => [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)],
    [Infinity, Infinity, -Infinity, -Infinity]);
  const fireFatality = (elapsed: number) => {
    const share = fireFrame && fireFrame.finalCollapse > 0 ? damageCurves(fireFrame, elapsed).collapse / fireFrame.finalCollapse : 0;
    return fire.fatalityShareBase + fire.fatalityShareCollapse * share;
  };

  for (const id of agentIds) {
    const items = timelines.get(id)!;
    const key = `${id}|${kind}|${start}|${target.id}`;
    const threshold = damageSeed(key), split = damageSeed(`${key}|outcome`);
    let found: { at: number; fatality: number; buildingId?: string } | undefined;
    if (kind === 'fire') {
      // Harm accumulates over each interval spent inside after ignition; solve for the crossing.
      let harm = 0;
      const a = fire.growthPerSecond2;
      const intervals: [number, number][] = [];
      for (const item of items) {
        // Only the active fire harms: [start, activeUntil).
        const from = Math.max(start, item.start), until = Math.min(activeUntil, item.end);
        if (until <= from) continue;
        if (item.stay) {
          if (fireLocations.has(item.stay.location)) intervals.push([from, until]);
        } else if (fireRings.length) {
          const trip = item.trip!;
          // Bounding-box overlap (a long segment can cross the footprint with both vertices outside); sampling decides.
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const [x, y] of trip.path) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
          if (x1 < fireBox[0] || x0 > fireBox[2] || y1 < fireBox[1] || y0 > fireBox[3]) continue;
          const step = fire.walkSampleSeconds;
          for (let t = from; t < until; t += step) {
            const point = pointOnTrip(trip, Math.min(until, t + step / 2));
            if (fireRings.some(ring => inside(point, ring))) intervals.push([t, Math.min(until, t + step)]);
          }
        }
      }
      intervals.sort((x, y) => x[0] - y[0]);
      // Merge touching pieces (a stay, then the walk out through the footprint) into continuous visits.
      const visits: [number, number][] = [];
      for (const [t1, t2] of intervals) {
        const last = visits.at(-1);
        if (last && t1 <= last[1] + 1e-6) last[1] = Math.max(last[1], t2); else visits.push([t1, t2]);
      }
      for (const [t1, t2] of visits) {
        const d = t2 - t1, gain = a / 2 * d * d;
        if (harm + gain >= threshold) {
          const at = t1 + Math.min(d, Math.sqrt(2 * (threshold - harm) / a));
          found = { at, fatality: fireFatality(at - start), ...(fireFrame ? { buildingId: fireFrame.id } : {}) };
          break;
        }
        harm += gain;
      }
    } else {
      const q = kind === 'earthquake' ? CASUALTY_ASSUMPTIONS.earthquake : CASUALTY_ASSUMPTIONS.meteor;
      const pulses: Pulse[] = [];
      // Indoors: at each damaged building's own collapse moment, if the person is inside it then.
      for (const frame of frames.values()) {
        const t = start + (kind === 'earthquake' ? (frame.timing.collapseStart + frame.timing.collapseEnd) / 2 : frame.timing.collapseStart);
        const state = t < DAY ? stateAt(items, t) : null;
        if (state && buildingOf(state)?.id === frame.id)
          pulses.push({ t, harm: q.indoorBase * frame.severity + q.collapseHarm * frame.finalCollapse,
            fatality: q.fatalityShareBase + q.fatalityShareCollapse * frame.finalCollapse, buildingId: frame.id });
      }
      // Outdoors within the radius.
      if (radius > 0) {
        let t: number | undefined;
        if (kind === 'earthquake') {
          t = start + DAMAGE_ASSUMPTIONS.earthquake.shakingSeconds / 2;
        } else {
          const before = stateAt(items, start);
          if (before && inOpenZone(before)) {
            const u = clamp01(metres(target.position, before.point) / radius);
            t = start + u * DAMAGE_ASSUMPTIONS.meteor.impactSeconds;
          }
        }
        const state = t !== undefined && t < DAY ? stateAt(items, t) : null;
        if (state && inOpenZone(state)) {
          const u = clamp01(metres(target.position, state.point) / radius);
          const m = DAMAGE_ASSUMPTIONS.meteor;
          const severity = kind === 'earthquake' ? 1 - u : u < m.innerFraction ? 1 : 0.1 + 0.8 * clamp01(1 - (u - m.innerFraction) / (1 - m.innerFraction));
          pulses.push({ t: t!, harm: q.outdoorHarm * severity, fatality: q.fatalityShareBase + (kind === 'meteor' ? q.fatalityShareCollapse * severity : 0) });
        }
      }
      pulses.sort((x, y) => x.t - y.t || compare(x.buildingId ?? '', y.buildingId ?? ''));
      let harm = 0;
      for (const pulse of pulses) {
        harm += pulse.harm;
        if (harm >= threshold) { found = { at: pulse.t, fatality: pulse.fatality, ...(pulse.buildingId ? { buildingId: pulse.buildingId } : {}) }; break; }
      }
    }
    if (!found) continue;
    const state = stateAt(items, found.at);
    if (!state) continue;
    events.push({ agentId: id, outcome: split < found.fatality ? 'fatality' : 'injured', at: found.at,
      position: [state.point[0], state.point[1]], cause: kind, ...(found.buildingId ? { buildingId: found.buildingId } : {}) });
  }
  return events.sort((a, b) => a.at - b.at || compare(a.agentId, b.agentId));
}
