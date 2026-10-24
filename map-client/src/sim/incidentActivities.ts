// Activity-aware inputs for incident decisions: what a stay is for, whether an alternative venue
// is open, and whether it has room. Pure helpers; decisions themselves live in incidents.ts.
import type { CampusData } from '../data/campusData';
import type { CampusLocation, DayData, Stay, StayPurpose } from './playback';
import { venueWindows } from './sourceDay';

/** Optional applyIncident context. Without it no venue hours are known, so nobody relocates. */
export interface IncidentContext { sourceData: CampusData; weekday: number }

export type IncidentActivity = StayPurpose['kind'] | 'unknown';
/**
 * relocate: moved to another compatible open venue with room, then continued the saved itinerary.
 * wait: waited (nearby, or at origin for arrivals) and resumed after reopening.
 * leave: left the building early on the next saved walk.
 * resume: drill occupant returned after release while meaningful activity time remained.
 * cancel: the visit (or the rest of it) was dropped and the saved itinerary continued.
 */
export type IncidentAction = 'relocate' | 'wait' | 'leave' | 'resume' | 'cancel';
export interface IncidentDecision {
  activity: IncidentActivity;
  action: IncidentAction;
  /** relocate: new venue; wait: waiting place (closure occupant) or visited building (arrival);
   * leave/cancel: next saved destination; resume: the building returned to. */
  destinationId?: string;
  reason: string;
  /** When the decision takes effect: exit for closures, release for drills, departure for arrivals. */
  at: number;
}

/** Illustrative, uncalibrated decision thresholds. */
export const ACTIVITY_DECISION_ASSUMPTIONS = {
  /** Minimum remaining activity time worth waiting or relocating for. */
  minimumUsefulSeconds: { class: 600, dining: 900, library: 1200, gym: 1200, estimated: 900 },
  /** A meal at least this share eaten when the incident starts is treated as finished. */
  mealFinishedShare: 0.6,
  /** Leaving early is allowed for home/off-campus walks, or when the saved walk is this close. */
  earlyLeaveHorizonSeconds: 3600,
  /** Longest walk considered to an alternative venue. */
  maxRelocationWalkSeconds: 900,
} as const;
export const ACTIVITY_DECISION_LIMITATIONS = [
  'Decisions use the stay purpose (or an exact published-class or modeled-activity interval match); untagged stays keep the generic incident behavior. Building kind never implies a class.',
  'Published classes are never moved. Closure occupants wait nearby when at least 10 minutes of class would remain after returning, otherwise leave on their next saved walk.',
  'Dining, library and gym visits may move to the nearest same-kind venue (saved walk at most 15 minutes) that is open for the whole relocated visit under published or carried-forward hours, is not restricted, is outside the incident footprint, and stays within its modeled capacity counting baseline occupancy and earlier relocations. Unknown hours are treated as closed.',
  'Relocation needs at least 15 (dining) or 20 (library, gym) useful minutes after walking and must beat waiting. A meal 60% eaten counts as finished. Relocated people continue to their next saved destination by a saved walk and never arrive later than originally scheduled.',
  'Drill occupants always evacuate and muster first; the building reopens at release, so drill decisions are resume or cancel, never relocate.',
] as const;

export const RELOCATABLE_KINDS = new Set<IncidentActivity>(['dining', 'library', 'gym']);
/** Activities whose decisions follow the activity policy; everything else keeps generic behavior. */
export const POLICY_KINDS = new Set<IncidentActivity>(['class', 'dining', 'library', 'gym', 'estimated']);
export const minimumUseful = (kind: IncidentActivity): number =>
  (ACTIVITY_DECISION_ASSUMPTIONS.minimumUsefulSeconds as Record<string, number>)[kind] ?? 900;

type Interval = { agentId: string; locationId: string; startSec: number; endSec: number };
type SourceMatches = {
  sourceAssignments?: (Interval & { meetingId: string; courseCode: string })[];
  sourceActivities?: (Interval & { kind: string; purpose?: string })[];
};
const intervalKey = (agent: string, location: string, start: number, end: number) => `${agent}\u0000${location}\u0000${start}\u0000${end}`;

/** Explicit stay purpose, else an exact (agent, location, start, end) source match. Never inferred from building kind. */
export function purposeResolver(day: DayData): (stay: Stay) => StayPurpose | undefined {
  const source = day as DayData & SourceMatches;
  const matches = new Map<string, StayPurpose>();
  for (const a of source.sourceActivities ?? []) {
    let purpose: StayPurpose | undefined;
    if (a.kind === 'dining' || a.kind === 'library' || a.kind === 'gym') purpose = { kind: a.kind, fixed: false };
    else if (a.kind === 'off-campus-meal' || a.kind === 'off-campus-outing' || a.kind === 'unmapped-academic') purpose = { kind: a.kind, fixed: false };
    else if (a.kind === 'estimated' && a.purpose && a.purpose !== 'unmapped-academic')
      purpose = { kind: 'estimated', fixed: false, purpose: a.purpose as Extract<StayPurpose, { kind: 'estimated' }>['purpose'] };
    if (purpose) matches.set(intervalKey(a.agentId, a.locationId, a.startSec, a.endSec), purpose);
  }
  // Published classes win any (unexpected) interval collision.
  for (const c of source.sourceAssignments ?? [])
    matches.set(intervalKey(c.agentId, c.locationId, c.startSec, c.endSec), { kind: 'class', fixed: true, meetingId: c.meetingId, courseCode: c.courseCode });
  return stay => stay.purpose ?? matches.get(intervalKey(stay.agent, stay.location, stay.start, stay.end));
}

/** Published or carried-forward hours cover [start, end). Restricted or unknown hours reject. */
export function venueOpenFor(context: IncidentContext, location: CampusLocation, start: number, end: number): boolean {
  if (context.sourceData.locations[location.id]?.hoursStatus === 'restricted') return false;
  return venueWindows(context.sourceData, location.id, location.kind, context.weekday, { carryForward: true })
    .some(([opens, closes]) => opens <= start && end <= closes);
}

/** Baseline presence plus relocation reservations, per location, for whole-visit capacity checks. */
export class VenueLedger {
  private baseline = new Map<string, [number, number][]>();
  private reserved = new Map<string, [number, number][]>();
  constructor(stays: readonly Stay[]) {
    for (const stay of stays) {
      const list = this.baseline.get(stay.location) ?? [];
      list.push([stay.start, stay.end]); this.baseline.set(stay.location, list);
    }
  }
  /** Peak concurrent presence within [start, end). */
  peak(location: string, start: number, end: number): number {
    const changes: [number, number][] = [];
    for (const list of [this.baseline.get(location) ?? [], this.reserved.get(location) ?? []])
      for (const [s, e] of list) if (s < end && e > start) changes.push([Math.max(s, start), 1], [e, -1]);
    changes.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let count = 0, peak = 0;
    for (const [, delta] of changes) { count += delta; peak = Math.max(peak, count); }
    return peak;
  }
  fits(location: CampusLocation, start: number, end: number): boolean {
    return Number.isFinite(location.capacity) && location.capacity > 0 && this.peak(location.id, start, end) + 1 <= location.capacity;
  }
  reserve(location: string, start: number, end: number) {
    const list = this.reserved.get(location) ?? [];
    list.push([start, end]); this.reserved.set(location, list);
  }
}
