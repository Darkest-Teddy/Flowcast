// How trains and buses move along their tracks: accelerating, cruising, braking into stops,
// dwelling, and waiting at red lights.
//
// Two users:
//   * Live (MbtaFeed): a follower per vehicle chases the reported positions one poll behind,
//     like the old linear glide, but with real speed limits, acceleration and braking. It holds
//     at a stop when the MBTA says STOPPED_AT (or TransLoc says speed 0), brakes into and dwells
//     at stops it must have served between reports, and stops at red signals on its approach.
//     If a hold leaves it more than ~150 m behind the latest report it skips dwells and ambers
//     to catch up; very far behind (missed polls, a long simulated red) it jumps.
//   * Playback (ScheduledTransit): each scheduled trip is planned once as legs from rest to rest
//     (trapezoidal speed profiles between stops), with a stop at every signal that is red when
//     the vehicle would reach it, then evaluated at any time in closed form.
//
// Stops and signal stop lines along each track are found once and cached.

import type { TransitRoute, TransitStop } from './mbta';
import { isUnderground, type Track } from './tracks';
import { lampAt, registeredSignals, secondsToGreen, type SignalApproach } from '../sim/signals';

export type VehicleKind = TransitRoute['kind'];

export interface Kinematics {
  cruise: number; // m/s, normal running speed between stops
  max: number; // m/s, never faster (catching up included)
  accel: number; // m/s²
  decel: number; // m/s², service braking
  halfLength: number; // metres: positions are the vehicle's centre
}

// Comm Ave, Beacon St and Mass Ave are posted 25 mph (11.2 m/s; Boston's citywide default since
// 2017). Green Line LRVs accelerate and brake at about 1.0-1.3 m/s² in service; buses ~1.2-1.5.
export const KINEMATICS: Record<VehicleKind, Kinematics> = {
  subway: { cruise: 10, max: 15.5, accel: 1.0, decel: 1.2, halfLength: 22.5 }, // two-car train, ~45 m
  bus: { cruise: 10.5, max: 14.5, accel: 1.2, decel: 1.4, halfLength: 6.1 }, // 40-ft bus
  shuttle: { cruise: 10, max: 14.5, accel: 1.2, decel: 1.4, halfLength: 6.1 },
};

const RAD = Math.PI / 180;
const METRES_PER_DEG_LAT = 110_540;
const metresPerDegLng = (lat: number) => 111_320 * Math.cos(lat * RAD);
const angleDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

// --------------------------------------------------------------------------------------------
// What lies along a track
// --------------------------------------------------------------------------------------------

export interface TrackStop {
  stopId: string;
  s: number; // where the vehicle's centre stops
}

export interface TrackSignal {
  id: string;
  group: string;
  axis: 0 | 1;
  movement?: string;
  line: number; // metres along the track of the stop line
  hold: number; // where the vehicle's centre waits: just short of the line
}

export interface TrackFeatures {
  stops: TrackStop[];
  signals: TrackSignal[];
}

const STOP_SNAP_METRES = 35;
const PLATFORM_SNAP_METRES = 40; // as street.ts draws them
// A bus stop is on the right-hand curb; one further left than this is the other direction's.
const STOP_LEFT_TOLERANCE = 2.5;
// A stop line (on its road's centreline) this close to a track governs it. Trains run in the Comm Ave
// median, beside the carriageway rather than on it, so their stop lines sit a little further off.
const SIGNAL_SNAP_METRES: Record<VehicleKind, number> = { subway: 16, bus: 12, shuttle: 12 };
const SIGNAL_BEARING_DEGREES = 35;
const STOP_LINE_GAP = 1.5; // the vehicle's nose stops this far short of the line
const BUS_DOOR_FROM_FRONT = 2; // a bus stops with its front door at the sign

// Green Line platforms are 60 m long and keep clear of the signalised crossing they're beside
// (street.ts draws them with this same rule).
export const PLATFORM_LENGTH = 60;
const CROSSING_CLEARANCE = 8;
const CROSSING_NEAR_TRACK = 30;

/** Nearest point of a track to `at`, with the signed sideways offset (right of travel positive). */
function project(track: Track, at: [number, number], filter?: (lateral: number) => boolean) {
  const kx = metresPerDegLng(at[1]);
  const p = track.points;
  let best: { s: number; distance: number; lateral: number; bearing: number } | null = null;
  for (let i = 1; i < p.length; i++) {
    const ax = (p[i - 1][0] - at[0]) * kx;
    const ay = (p[i - 1][1] - at[1]) * METRES_PER_DEG_LAT;
    const segX = (p[i][0] - p[i - 1][0]) * kx;
    const segY = (p[i][1] - p[i - 1][1]) * METRES_PER_DEG_LAT;
    const len2 = segX * segX + segY * segY;
    if (len2 === 0) continue;
    const f = Math.max(0, Math.min(1, -(ax * segX + ay * segY) / len2));
    const cx = ax + segX * f; // closest point, relative to `at`
    const cy = ay + segY * f;
    const distance = Math.hypot(cx, cy);
    // `at` relative to the closest point, crossed with the travel direction: right is positive.
    const len = Math.sqrt(len2);
    const lateral = (-cx * segY + cy * segX) / len;
    if (filter && !filter(lateral)) continue;
    if (!best || distance < best.distance) {
      best = {
        s: track.cumulative[i - 1] + f * (track.cumulative[i] - track.cumulative[i - 1]),
        distance,
        lateral,
        bearing: ((Math.atan2(segX, segY) / RAD) + 360) % 360,
      };
    }
  }
  return best;
}

/** Signalised crossing centres (each intersection's poles averaged). */
function crossingCentres(signals: { group: string; position?: [number, number]; stopLine?: [number, number] }[]): [number, number][] {
  const groups = new Map<string, [number, number][]>();
  for (const s of signals) {
    const p = s.position ?? s.stopLine;
    if (p) groups.set(s.group, [...(groups.get(s.group) ?? []), p]);
  }
  return [...groups.values()].map((ps) => [ps.reduce((a, p) => a + p[0], 0) / ps.length, ps.reduce((a, p) => a + p[1], 0) / ps.length]);
}

/** Centre of a Green Line platform at `s`, moved clear of the nearest signalised crossing. */
export function platformCentre(track: Track, s: number, crossings: [number, number][]): number {
  const half = PLATFORM_LENGTH / 2;
  const near = crossings
    .map((c) => project(track, c))
    .filter((c) => c && c.distance < CROSSING_NEAR_TRACK)
    .map((c) => c!.s)
    .sort((a, b) => Math.abs(a - s) - Math.abs(b - s));
  const j = near[0];
  if (j !== undefined && Math.abs(s - j) < half + CROSSING_CLEARANCE) {
    s = s >= j - 5 ? j + CROSSING_CLEARANCE + half : j - CROSSING_CLEARANCE - half;
  }
  return Math.max(half, Math.min(track.length - half, s));
}

/** Stops this track's vehicles serve, where their centre comes to rest, in order along the track. */
export function stopsAlong(track: Track, kind: VehicleKind, stops: TransitStop[], signals: { group: string; position?: [number, number] }[] = []): TrackStop[] {
  const kin = KINEMATICS[kind];
  const crossings = kind === 'subway' ? crossingCentres(signals) : [];
  return stops
    .filter((stop) => stop.routes.includes(track.route))
    .flatMap((stop) => {
      // Stations serve both tracks; a bus stop only the side of the street it's on.
      const hit = project(track, stop.position, kind === 'subway' ? undefined : (lateral) => lateral >= -STOP_LEFT_TOLERANCE);
      if (!hit || hit.distance > (kind === 'subway' ? PLATFORM_SNAP_METRES : STOP_SNAP_METRES)) return [];
      const s = kind === 'subway' ? platformCentre(track, hit.s, crossings) : hit.s + kin.halfLength - BUS_DOOR_FROM_FRONT;
      return [{ stopId: stop.id, s: Math.max(0, Math.min(track.length, s)) }];
    })
    .sort((a, b) => a.s - b.s);
}

/** Signal stop lines this track's vehicles must obey: on the track and facing its direction. */
export function signalsAlong(track: Track, kind: VehicleKind, approaches: SignalApproach[]): TrackSignal[] {
  const kin = KINEMATICS[kind];
  const out: TrackSignal[] = [];
  for (const a of approaches) {
    if (a.flash || !a.stopLine || a.approach === undefined) continue;
    const hit = project(track, a.stopLine);
    if (!hit || hit.distance > SIGNAL_SNAP_METRES[kind]) continue;
    if (angleDiff(hit.bearing, a.approach) > SIGNAL_BEARING_DEGREES) continue;
    if (isUnderground(track, hit.s)) continue;
    const hold = hit.s - kin.halfLength - STOP_LINE_GAP;
    if (hold < 0) continue;
    // One stop line per intersection per pass (OSM often maps both the stop line and the junction).
    const dupe = out.find((o) => o.group === a.group && Math.abs(o.line - hit.s) < 40);
    if (dupe) {
      if (hit.s < dupe.line) Object.assign(dupe, { id: a.id, axis: a.axis, movement: a.movement, line: hit.s, hold });
      continue;
    }
    out.push({ id: a.id, group: a.group, axis: a.axis, movement: a.movement, line: hit.s, hold });
  }
  return out.sort((x, y) => x.line - y.line);
}

const featureCache = new WeakMap<Track, { version: number; stopCount: number; features: TrackFeatures }>();

/** Stops and signals along a track, computed once (and again if the street or stops change). */
export function trackFeatures(track: Track, kind: VehicleKind, stops: TransitStop[]): TrackFeatures {
  const { approaches, version } = registeredSignals();
  const cached = featureCache.get(track);
  if (cached && cached.version === version && cached.stopCount === stops.length) return cached.features;
  const features = { stops: stopsAlong(track, kind, stops, approaches as { group: string; position?: [number, number] }[]), signals: signalsAlong(track, kind, approaches) };
  featureCache.set(track, { version, stopCount: stops.length, features });
  return features;
}

// --------------------------------------------------------------------------------------------
// Live: a follower chasing the reports
// --------------------------------------------------------------------------------------------

export type Holding = 'stop' | 'signal' | 'traffic' | null;

/** What the latest report says: glide from `sFrom` to `sTo` over `interval` ms from `receivedAt`. */
export interface LiveTarget {
  sFrom: number;
  sTo: number;
  receivedAt: number; // performance.now() ms
  interval: number; // ms
  stopped: boolean; // the report says the vehicle is standing still
}

export interface Follower {
  s: number;
  v: number;
  lastNow: number;
  servedS: number; // the last stop already served (dwelt at or held at)
  dwell: { s: number; since: number } | null;
  committed: Set<string>; // signals it chose to clear on amber
  holding: Holding;
  jumps: number;
}

export function newFollower(s: number, now: number, stops: TrackStop[]): Follower {
  // A stop it's already standing at when first seen counts as served.
  const here = stops.find((x) => Math.abs(x.s - s) < 5);
  return { s, v: 0, lastNow: now, servedS: here ? here.s : -Infinity, dwell: null, committed: new Set(), holding: null, jumps: 0 };
}

const TRACK_GAIN = 0.4; // 1/s: how hard the follower closes the gap to where the report puts it
const CATCH_UP_METRES = 150;
export const JUMP_METRES = 350;
const OVERRUN_SECONDS = 4; // past the latest report, keep going this long at its speed (reports run late)
const OVERRUN_MAX = 40;
const STOP_REACH = 5; // a report this close short of a stop counts as at it
const REPORTED_STOP_RADIUS = 30;
const AMBER_MAX_DECEL = 3; // m/s²: harder than this to stop for an amber, and it goes through
const DWELL: Record<VehicleKind, [number, number]> = { subway: [8, 20], bus: [4, 12], shuttle: [5, 15] }; // [min, max] s
const DWELL_LEAVE_LAG = 40; // past the minimum dwell, leave once this far behind

/**
 * Advance a live vehicle to `now` (performance.now() ms). `signalTime` is the signal clock
 * (seconds since midnight, the wall clock in Live).
 */
export function stepFollower(
  f: Follower,
  track: Track,
  features: TrackFeatures,
  kind: VehicleKind,
  target: LiveTarget,
  now: number,
  signalTime: number,
): void {
  const kin = KINEMATICS[kind];
  const dt = Math.max(0, Math.min(0.25, (now - f.lastNow) / 1000));
  f.lastNow = now;

  // Where the report says the vehicle should be drawn now, and how fast that point moves.
  const iv = target.interval / 1000;
  const elapsed = (now - target.receivedAt) / 1000;
  const vSeg = Math.max(0, (target.sTo - target.sFrom) / iv);
  const overrun = target.stopped ? 0 : Math.min(vSeg * OVERRUN_SECONDS, OVERRUN_MAX);
  let sT: number;
  let vT: number;
  if (elapsed <= iv) {
    sT = target.sFrom + (target.sTo - target.sFrom) * Math.max(0, elapsed / iv);
    vT = vSeg;
  } else {
    sT = Math.min(target.sTo + vSeg * (elapsed - iv), target.sTo + overrun);
    vT = sT < target.sTo + overrun ? vSeg : 0;
  }
  if (sT - f.s > JUMP_METRES) {
    f.s = sT;
    f.v = Math.min(vT, kin.max);
    f.dwell = null;
    f.jumps++;
  }
  const lag = sT - f.s;
  const catchUp = lag > CATCH_UP_METRES;

  // The furthest it may go: the report (plus a little overrun while moving), never backwards.
  let limit = target.sTo + overrun;
  let limitKind: Holding = null;
  if (target.stopped) {
    // Stopped at a stop: wait at the stop itself rather than at the GPS fix.
    const at = features.stops.find((x) => Math.abs(x.s - target.sTo) < REPORTED_STOP_RADIUS && x.s >= f.s - 1);
    limit = at ? at.s : target.sTo;
    // The MBTA only says STOPPED_AT at a stop; BU's feed just reports a speed of 0, which may be traffic.
    limitKind = at || kind !== 'shuttle' ? 'stop' : 'traffic';
    if (at && f.s >= at.s - 1) f.servedS = Math.max(f.servedS, at.s);
  }

  // The next stop it hasn't served yet: dwell there if the report is at or past it, otherwise
  // don't run past it (it'll be stopping there).
  let dwellAt: number | null = null;
  for (const stop of features.stops) {
    if (stop.s < f.s - 1 || stop.s <= f.servedS + 0.5) continue;
    if (stop.s >= limit - 0.5) break;
    if (stop.s <= target.sTo + STOP_REACH) {
      if (!catchUp) dwellAt = stop.s;
      else if (f.s > stop.s - 1) f.servedS = stop.s;
    } else {
      limit = stop.s;
      limitKind = null;
    }
    break;
  }

  // Dwelling: stay put until the dwell is done (sooner if falling behind).
  if (f.dwell) {
    const held = (now - f.dwell.since) / 1000;
    const [min, max] = DWELL[kind];
    if (held < max && !catchUp && !(held >= min && lag > DWELL_LEAVE_LAG)) {
      f.v = 0;
      f.holding = 'stop';
      return;
    }
    f.servedS = Math.max(f.servedS, f.dwell.s);
    f.dwell = null;
    dwellAt = null;
  }

  let stopAt = Math.max(f.s, limit);
  let stopKind: Holding = limitKind;
  if (dwellAt !== null && dwellAt < stopAt) {
    stopAt = Math.max(f.s, dwellAt);
    stopKind = 'stop';
  }

  // Signals between here and that point: stop for red, and for amber if it comfortably can.
  for (const sig of features.signals) {
    // Behind it once the nose is past the line. (Standing at a platform can leave the centre
    // past the hold point with the nose still short of the line: it still waits there.)
    if (sig.hold + STOP_LINE_GAP <= f.s + 0.05) {
      f.committed.delete(sig.id);
      continue;
    }
    if (sig.hold > stopAt) break; // its nose won't reach this line
    const lamp = lampAt(signalTime, sig.group, sig.axis, false, sig.movement);
    if (lamp === 'green') continue;
    if (f.committed.has(sig.id)) continue;
    const gap = sig.hold - f.s;
    if (lamp === 'amber' && (catchUp || (gap > 0.3 && (f.v * f.v) / (2 * gap) > AMBER_MAX_DECEL))) {
      f.committed.add(sig.id);
      continue;
    }
    stopAt = Math.max(f.s, sig.hold);
    stopKind = 'signal';
    break;
  }

  // Speed: chase the report, within the speed limit, acceleration and braking curve.
  let want = lag < 0.3 && vT === 0 ? 0 : vT + TRACK_GAIN * lag;
  want = Math.max(0, Math.min(kin.max, want));
  let v = Math.max(f.v - 2.5 * kin.decel * dt, Math.min(f.v + kin.accel * dt, want));
  const gap = stopAt - f.s;
  v = Math.min(v, Math.sqrt(2 * kin.decel * Math.max(0, gap)));
  let s = f.s + v * dt;
  if (s >= stopAt - 0.05) {
    s = Math.max(f.s, stopAt);
    if (gap < 0.5) v = 0;
  }
  f.s = s;
  f.v = v;
  // Standing still short of any stop or signal: waiting for the report to move (traffic).
  f.holding = v === 0 ? (stopAt - s < 0.3 ? stopKind : null) ?? 'traffic' : null;
  if (f.holding === 'stop' && dwellAt !== null && Math.abs(s - dwellAt) < 0.3) f.dwell = { s: dwellAt, since: now };
}

// --------------------------------------------------------------------------------------------
// Playback: trips planned from rest to rest
// --------------------------------------------------------------------------------------------

/** A stretch of a trip: moving from rest to rest along a trapezoidal profile, or standing. */
interface Leg {
  t0: number; // sim seconds
  t1: number;
  s0: number;
  s1: number;
  hold?: 'stop' | 'signal';
  // Moving legs: accelerate for ta at `a`, cruise at vp for tc, brake for tb at `b`.
  vp?: number;
  ta?: number;
  tc?: number;
  a?: number;
  b?: number;
}

export interface TripPlan {
  legs: Leg[];
  end: number; // sim seconds when it reaches the end of the track
  arrivals: Map<string, number>; // stopId -> sim seconds it arrives there
}

function moveLeg(s0: number, s1: number, t0: number, kin: Kinematics): Leg {
  const d = Math.max(0, s1 - s0);
  const a = kin.accel;
  const b = kin.decel;
  let vp = kin.cruise;
  let tc = 0;
  if (d >= (vp * vp) / (2 * a) + (vp * vp) / (2 * b)) {
    tc = (d - (vp * vp) / (2 * a) - (vp * vp) / (2 * b)) / vp;
  } else {
    vp = Math.sqrt((2 * d * a * b) / (a + b));
  }
  const ta = vp / a;
  const tb = vp / b;
  return { t0, t1: t0 + ta + tc + tb, s0, s1: s0 + d, vp, ta, tc, a, b };
}

/** Metres along and speed at time `t` within a moving leg. */
function legAt(leg: Leg, t: number): { s: number; v: number } {
  const tau = Math.max(0, Math.min(leg.t1 - leg.t0, t - leg.t0));
  const { vp = 0, ta = 0, tc = 0, a = 1, b = 1 } = leg;
  if (tau <= ta) return { s: leg.s0 + 0.5 * a * tau * tau, v: a * tau };
  const sa = 0.5 * a * ta * ta;
  if (tau <= ta + tc) return { s: leg.s0 + sa + vp * (tau - ta), v: vp };
  const u = tau - ta - tc;
  return { s: Math.min(leg.s1, leg.s0 + sa + vp * tc + vp * u - 0.5 * b * u * u), v: Math.max(0, vp - b * u) };
}

/** Sim time at which a moving leg reaches `x` metres along the track. */
function legTimeAt(leg: Leg, x: number): number {
  const { vp = 0, ta = 0, tc = 0, a = 1, b = 1 } = leg;
  const d = Math.max(0, Math.min(leg.s1 - leg.s0, x - leg.s0));
  const sa = 0.5 * a * ta * ta;
  if (d <= sa) return leg.t0 + Math.sqrt((2 * d) / a);
  if (d <= sa + vp * tc) return leg.t0 + ta + (d - sa) / vp;
  const rest = Math.max(0, leg.s1 - leg.s0 - d); // distance still to go while braking
  return leg.t1 - Math.sqrt((2 * rest) / b);
}

/**
 * Plan one trip departing the start of the track at `depart` (sim seconds): run to each stop,
 * dwell, and stop at any signal that would be red when the vehicle's nose reaches its line.
 */
export function planTrip(track: Track, features: TrackFeatures, kind: VehicleKind, depart: number, dwell: number): TripPlan {
  const kin = KINEMATICS[kind];
  const legs: Leg[] = [];
  const arrivals = new Map<string, number>();
  let s = 0;
  let t = depart;
  let stopIndex = 0;
  let guard = 0;
  while (s < track.length - 0.5 && guard++ < 500) {
    while (stopIndex < features.stops.length && features.stops[stopIndex].s < s + 0.5) stopIndex++;
    const stop = features.stops[stopIndex];
    const goal = stop ? stop.s : track.length;
    let leg = moveLeg(s, goal, t, kin);
    let red: TrackSignal | null = null;
    let redAt = 0;
    // Signals whose line the nose crosses on the way: from here (nose not yet past the line,
    // even if the centre is past the hold point, as at a platform) to the goal.
    for (const sig of features.signals) {
      if (sig.hold + STOP_LINE_GAP <= s + 0.05) continue;
      if (sig.hold + STOP_LINE_GAP >= goal) break;
      const when = legTimeAt(leg, sig.hold + STOP_LINE_GAP);
      if (lampAt(when, sig.group, sig.axis, false, sig.movement) === 'red') {
        red = sig;
        redAt = when;
        break;
      }
    }
    if (red) {
      const wait = Math.max(s, red.hold);
      leg = moveLeg(s, wait, t, kin);
      legs.push(leg);
      // Wait for the green that ends the red it would have met (always later than `t`, so the
      // plan moves on even when it was green on arrival and turns red as it sets off).
      const green = redAt + secondsToGreen(redAt, red.group, red.axis, red.movement);
      const seconds = Math.max(0, green - leg.t1);
      if (seconds > 0) legs.push({ t0: leg.t1, t1: leg.t1 + seconds, s0: wait, s1: wait, hold: 'signal' });
      s = wait;
      t = leg.t1 + seconds;
      continue;
    }
    legs.push(leg);
    s = goal;
    t = leg.t1;
    if (stop) {
      arrivals.set(stop.stopId, t);
      legs.push({ t0: t, t1: t + dwell, s0: s, s1: s, hold: 'stop' });
      t += dwell;
    }
  }
  return { legs, end: t, arrivals };
}

/** Where a planned trip is at sim time `t`; null before it departs or after it ends. */
export function tripAt(plan: TripPlan, t: number): { s: number; v: number; holding: Holding } | null {
  const { legs } = plan;
  if (!legs.length || t < legs[0].t0 || t > plan.end) return null;
  let lo = 0;
  let hi = legs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (legs[mid].t0 <= t) lo = mid;
    else hi = mid - 1;
  }
  const leg = legs[lo];
  if (leg.hold) return { s: leg.s0, v: 0, holding: leg.hold };
  const { s, v } = legAt(leg, t);
  return { s, v, holding: null };
}

/** Typical trip time without signal waits, for scheduling. */
export function nominalTripSeconds(track: Track, features: TrackFeatures, kind: VehicleKind, dwell: number): number {
  const kin = KINEMATICS[kind];
  let s = 0;
  let t = 0;
  for (const stop of features.stops) {
    if (stop.s < s + 0.5) continue;
    const leg = moveLeg(s, stop.s, t, kin);
    t = leg.t1 + dwell;
    s = stop.s;
  }
  return moveLeg(s, track.length, t, kin).t1;
}
