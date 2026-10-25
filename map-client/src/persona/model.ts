/*
 * What a joined student is, and what they are doing.
 *
 * Shared by both apps: the dashboard's /join flow writes a Persona, the map reads it. It lives in
 * map-client/src because the dashboard can import across (`@map/*`) and the map cannot import back.
 * `web/src/lib/personaShared.ts` re-exports this under the name the design handoff uses.
 *
 * Pure data and arithmetic: no DOM, no three.js, no deck.gl, so both apps and the tests can load it.
 */

import type { Appearance } from './parts';

export type { Appearance } from './parts';

/** One student who scanned the QR code and built a character. */
export interface Persona {
  id: string;
  name: string;
  /** Free text, optional, shown with the character. */
  bio: string;
  appearance: Appearance;
  /** Which campus location they said they hang out at; keys into LOCATIONS. */
  homeLocationId: string;
  /** Epoch ms, for ordering and for pruning stale joins. */
  joinedAt: number;
}

export interface CampusLocation {
  id: string;
  name: string;
}

/**
 * Where a student can say they hang out.
 *
 * The handoff's own list, kept verbatim so the copy on the phone matches the design. These are
 * names, not geography: the map resolves each to a real position from its own campus data
 * (see persona/placement.ts), so the coordinates are never duplicated here.
 */
export const LOCATIONS: readonly CampusLocation[] = [
  { id: 'warren', name: 'Warren Towers' },
  { id: 'myles', name: 'Myles Standish Hall' },
  { id: 'stuvi', name: 'Student Village' },
  { id: 'cas', name: 'College of Arts and Sciences' },
  { id: 'cds', name: 'Computing & Data Sciences' },
  { id: 'questrom', name: 'Questrom School of Business' },
  { id: 'epic', name: 'Engineering Product Innovation Center' },
  { id: 'mugar', name: 'Mugar Memorial Library' },
  { id: 'pardee', name: 'Pardee Management Library' },
  { id: 'sel', name: 'Science & Engineering Library' },
  { id: 'gsu', name: 'George Sherman Union' },
  { id: 'warren-dining', name: 'Warren Towers Dining Hall' },
  { id: 'agganis', name: 'Agganis Arena' },
  { id: 'nickerson', name: 'Nickerson Field' },
];

export const DEFAULT_LOCATION_ID = 'warren';

export function locationName(id: string): string {
  return (LOCATIONS.find((l) => l.id === id) ?? LOCATIONS[0]).name;
}

/** A small stable hash, so every persona's day is their own but never random between frames. */
export function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/*
 * A joined student's day is a loop, not a simulation: they sit at their home location, walk to one
 * other place, and walk back. The cycle is C seconds long with two W-second walks in the middle of
 * it, offset per persona by their id hash so a crowd of joins does not move in lockstep.
 *
 * Both the status ("what they're doing") and the plan ("what they're going to do") read this one
 * function, so the two can never disagree.
 */
const CYCLE = 150;
const WALK = 22;

export type Phase = 'home-before' | 'to-target' | 'to-home' | 'home-after';

export interface Journey {
  phase: Phase;
  home: CampusLocation;
  /** The one other place this persona goes. Deterministic from their home. */
  target: CampusLocation;
  /** 0..1 through the current walk; 0 while they are at home. */
  progress: number;
}

export function journey(p: Pick<Persona, 'id' | 'homeLocationId'>, nowMs: number): Journey {
  const home = LOCATIONS.find((l) => l.id === p.homeLocationId) || LOCATIONS[0];
  const others = LOCATIONS.filter((l) => l.id !== home.id);
  const target = others[hashId(home.id) % others.length];
  const t = (((nowMs / 1000 + (hashId(p.id) % CYCLE)) % CYCLE) + CYCLE) % CYCLE;
  const outStart = (CYCLE - WALK * 2) / 2;
  const backStart = outStart + WALK;
  const idleAgain = backStart + WALK;
  if (t < outStart) return { phase: 'home-before', home, target, progress: 0 };
  if (t < backStart) return { phase: 'to-target', home, target, progress: (t - outStart) / WALK };
  if (t < idleAgain) return { phase: 'to-home', home, target, progress: (t - backStart) / WALK };
  return { phase: 'home-after', home, target, progress: 0 };
}

/**
 * What they are doing right now. The handoff's wording, unchanged: "At Warren Towers" or
 * "Walking to Agganis Arena".
 */
export function statusText(p: Pick<Persona, 'id' | 'homeLocationId'>, nowMs: number): string {
  const j = journey(p, nowMs);
  if (j.phase === 'home-before' || j.phase === 'home-after') return 'At ' + j.home.name;
  return 'Walking to ' + (j.phase === 'to-target' ? j.target.name : j.home.name);
}

/**
 * What they are *planning* to do -- the next leg of the loop rather than the current one.
 *
 * The handoff only specifies statusText(); "what they are planning to do" is derived from the same
 * deterministic journey so the two always agree. Phrased as intent, and always names somewhere they
 * are not yet, which is what makes it read as a plan and not a repeat of the status line.
 */
export function planText(p: Pick<Persona, 'id' | 'homeLocationId'>, nowMs: number): string {
  const j = journey(p, nowMs);
  switch (j.phase) {
    case 'home-before':
      return `Heading over to ${j.target.name} soon`;
    case 'to-target':
      return `Going to ${j.target.name}, then back to ${j.home.name}`;
    case 'to-home':
      return `Heading back to ${j.home.name}`;
    case 'home-after':
      return `Staying at ${j.home.name} for now`;
  }
}

/** True while the character should play its walk clip rather than idle. */
export function isWalking(p: Pick<Persona, 'id' | 'homeLocationId'>, nowMs: number): boolean {
  const { phase } = journey(p, nowMs);
  return phase === 'to-target' || phase === 'to-home';
}

/** The label drawn over a joined character on the map. The star is what separates them from the sim crowd. */
export const JOINED_MARK = '★';

export function joinedLabel(p: Pick<Persona, 'name'>): string {
  return `${JOINED_MARK} ${p.name}`;
}

export function newPersonaId(): string {
  return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}
