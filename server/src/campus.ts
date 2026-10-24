// Loads the same bundled data the map plays, and builds the same simulation, so the server's
// answers match what the map shows. Each weekday takes several seconds to build (blocking the
// event loop while it runs); days are built one at a time, in the background, and kept in a small
// LRU cache.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expandDay, Playback, type CampusLocation, type WalkRoute } from '../../map-client/src/sim/playback';
import { buildPopulation, type PopulationBase } from '../../map-client/src/sim/population';
import { buildSourceDay } from '../../map-client/src/sim/sourceDay';
import { askMeetings } from '../../map-client/src/insights';
import type { CampusData, SourceMeeting } from '../../map-client/src/data/campusData';

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

export const PUBLIC_BUNDLE = 'map-client/public/data/campus-data.json';
export const PRIVATE_BUNDLE = 'data-pipeline/.cache/hackathon/campus-data.json';

/**
 * Which campus bundle to load. Tool outputs are sent to OpenAI, and the project spec keeps
 * private or imported schedules out of optional model prompts, so the private hackathon bundle is
 * used only when FLOWCAST_ASK_PRIVATE_BUNDLE=1 is set and the file exists.
 */
export function chooseBundle(env: Record<string, string | undefined>, exists: (relPath: string) => boolean): { path: string; private: boolean } {
  const usePrivate = env.FLOWCAST_ASK_PRIVATE_BUNDLE === '1' && exists(PRIVATE_BUNDLE);
  return { path: usePrivate ? PRIVATE_BUNDLE : PUBLIC_BUNDLE, private: usePrivate };
}


/**
 * Builds values by key at most once at a time, keeps up to `capacity` built values and evicts the
 * least recently used one. A failed build is dropped so the next request retries it.
 */
export class BuildCache<K, V> {
  private readonly built = new Map<K, V>(); // insertion order = recency
  private readonly building = new Map<K, Promise<V>>();

  constructor(private readonly build: (key: K) => V | Promise<V>, private readonly capacity: number) {
    if (!(capacity >= 1)) throw new Error('BuildCache capacity must be at least 1');
  }

  /** The built value, or undefined while it isn't built. Marks it recently used. */
  ready(key: K): V | undefined {
    const value = this.built.get(key);
    if (value !== undefined) {
      this.built.delete(key);
      this.built.set(key, value);
    }
    return value;
  }

  isBuilding(key: K): boolean {
    return this.building.has(key);
  }

  /** The value, starting its build on the next tick if it isn't built or being built. */
  get(key: K): Promise<V> {
    const value = this.ready(key);
    if (value !== undefined) return Promise.resolve(value);
    let pending = this.building.get(key);
    if (!pending) {
      // Deferred so the request that triggers a build can respond before the build blocks the loop.
      pending = new Promise<V>((resolve, reject) =>
        setImmediate(() => {
          try { resolve(this.build(key)); } catch (error) { reject(error); }
        }),
      ).then(
        (v) => {
          this.building.delete(key);
          this.built.set(key, v);
          while (this.built.size > this.capacity) this.built.delete(this.built.keys().next().value as K);
          return v;
        },
        (error) => {
          this.building.delete(key);
          throw error;
        },
      );
      this.building.set(key, pending);
    }
    return pending;
  }
}

export interface CampusModel {
  locations: CampusLocation[];
  walkRoutes: Record<string, WalkRoute>;
  /** Meetings with their reference-week intervals (see askMeetings). */
  meetings: { locationId: string; meeting: SourceMeeting }[];
  /** Playback for a weekday (0 = Monday) when it is built, else undefined. */
  ready(weekday: number): Playback | undefined;
  /** Playback for a weekday, starting or joining its build. */
  playback(weekday: number): Promise<Playback>;
  /** Whether the private hackathon bundle was loaded (FLOWCAST_ASK_PRIVATE_BUNDLE=1). */
  privateBundle: boolean;
  /** How many built days are kept. */
  daysCached: number;
}

export function daysCachedFrom(env: Record<string, string | undefined>): number {
  const n = Number(env.FLOWCAST_ASK_DAYS_CACHED ?? 7);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 7) : 7;
}

export function loadCampusModel(env: Record<string, string | undefined> = process.env): CampusModel {
  const day = expandDay(readJson(root('map-client/public/data/demo-day.json')));
  const bundle = chooseBundle(env, (path) => existsSync(root(path)));
  const campus: CampusData = readJson(root(bundle.path));
  const population = readJson(root('map-client/public/data/population.json'));
  const base: PopulationBase = buildPopulation(day, campus, population);
  const daysCached = daysCachedFrom(env);
  const days = new BuildCache<number, Playback>((weekday) => new Playback(buildSourceDay(base, campus, weekday)), daysCached);

  return {
    locations: base.locations.filter((l) => l.kind !== 'off-campus'),
    walkRoutes: (day as { walkRoutes?: Record<string, WalkRoute> }).walkRoutes ?? {},
    meetings: askMeetings(campus),
    ready: (weekday) => days.ready(weekday),
    playback: (weekday) => days.get(weekday),
    privateBundle: bundle.private,
    daysCached,
  };
}
