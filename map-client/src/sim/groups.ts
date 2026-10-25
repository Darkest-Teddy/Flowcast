// Friends eating together. Without this everyone walks and eats alone; with it some campus meals
// are shared by 2–4 students who plausibly know each other: dorm-mates (same residence) or
// classmates leaving the same class just before. A group shares one venue, one start and one end,
// and members walk to and from the meal at the first member's pace, so dorm-mates leaving the same
// residence for the same meal walk side by side (playback offsets them across the sidewalk).
//
// How groups form (sim/sourceDay.ts, while planning each student's day in its stable order): a
// "social" meal first looks for an open table — one a dorm-mate or classmate opened for the same
// meal slot within an hour of when this student would eat — and joins it when the student's day,
// the venue's hours and its seats allow (the usual feasibility and capacity checks). Otherwise the
// student eats as before and opens a table of their own for later students to join. Everything is
// keyed by hashes of the student and the day, never Math.random.
//
// Assumptions, uncalibrated: 40% of on-campus dining-hall meals are "social", so that about a
// quarter of all of them end up shared (21–26% on a Wednesday); a table seats 2 (50%), 3 (30%) or
// 4 (20%); joiners shift their meal by at most an hour to eat with friends; classmates
// count only when the class ended at most 30 minutes before the meal. Off-campus meals, study
// sessions and workouts are still taken alone. No observed friendship network is asserted.

/** Share of on-campus dining-hall meals whose student eats with friends when a table can be found. */
export const MEAL_GROUP_SOCIAL_SHARE = 0.4;
/** Table sizes (people, including the student who opened it) and their shares. */
export const MEAL_GROUP_SIZES: readonly (readonly [number, number])[] = [[2, 0.5], [3, 0.3], [4, 0.2]];
/** A joiner eats at most this far (seconds) from their own planned meal time. */
export const MEAL_GROUP_MAX_SHIFT_SECONDS = 60 * 60;
/** Classmates: the shared class ended at most this long (seconds) before the meal. */
export const MEAL_GROUP_CLASS_GAP_SECONDS = 30 * 60;
/** Tables a joiner tries (nearest in time first) before eating on their own. */
const TABLES_TRIED = 3;

export const MEAL_GROUP_ASSUMPTION = 'Some campus meals are shared: 40% of on-campus dining-hall meals look for a table of 2–4 opened by a dorm-mate (same residence) or a classmate (same class ending at most 30 minutes before) for the same meal within an hour, and join it when the day, hours and seats allow; otherwise the student eats as before and opens a table (about a quarter of campus meals end up shared). Members share venue, start and end, and walk to and from it at the first member’s pace. Uncalibrated assumption; no friendship data.';

export const isSocialMeal = (u: number): boolean => u < MEAL_GROUP_SOCIAL_SHARE;

/** Table size for a stable draw u ∈ [0, 1). */
export function mealGroupSize(u: number): number {
  let left = u;
  for (const [size, share] of MEAL_GROUP_SIZES) { if ((left -= share) < 0) return size; }
  return MEAL_GROUP_SIZES.at(-1)![0];
}

/** Keys under which a table is found: dorm-mates by residence, classmates by class meeting. */
export const homeTableKey = (slot: string, home: string): string => `${slot}|home|${home}`;
export const classTableKey = (slot: string, meetingId: string): string => `${slot}|class|${meetingId}`;

export interface MealTable<S> {
  id: string;
  location: string;
  start: number;
  end: number;
  /** Seats at the table, including the student who opened it. */
  size: number;
  /** Walking speed (m/s) of the student who opened it; members walk to and from the meal at it. */
  pace: number;
  /** Student ids, opener first. */
  members: string[];
  /** Each member's planned stop for this meal (opener first). */
  stops: S[];
}

/** The day's open and filled tables; one instance per simulated day. */
export class MealTables<S extends object> {
  private readonly byKey = new Map<string, MealTable<S>[]>();
  private readonly byStop = new WeakMap<S, MealTable<S>>();
  readonly tables: MealTable<S>[] = [];

  /** Open a table for `stop`, findable under `keys`. */
  open(table: Omit<MealTable<S>, 'members' | 'stops'>, agentId: string, stop: S, keys: readonly string[]): MealTable<S> {
    const row: MealTable<S> = { ...table, members: [agentId], stops: [stop] };
    this.tables.push(row); this.byStop.set(stop, row);
    for (const key of keys) { const list = this.byKey.get(key) ?? []; list.push(row); this.byKey.set(key, list); }
    return row;
  }

  /** Open tables under any of `keys`, within the shift limit of `start`, nearest first (stable). */
  find(keys: readonly string[], start: number): MealTable<S>[] {
    const found = new Set<MealTable<S>>();
    for (const key of keys) for (const table of this.byKey.get(key) ?? []) {
      if (table.members.length < table.size && Math.abs(table.start - start) <= MEAL_GROUP_MAX_SHIFT_SECONDS) found.add(table);
    }
    return [...found].sort((a, b) => Math.abs(a.start - start) - Math.abs(b.start - start) || a.id.localeCompare(b.id)).slice(0, TABLES_TRIED);
  }

  join(table: MealTable<S>, agentId: string, stop: S): void {
    table.members.push(agentId); table.stops.push(stop); this.byStop.set(stop, table);
  }

  /** The table a planned stop belongs to, when it has company (two or more members). */
  groupOf(stop: S): MealTable<S> | undefined {
    const table = this.byStop.get(stop);
    return table && table.members.length > 1 ? table : undefined;
  }
}

/** Most people drawn side by side across a sidewalk; a bigger crowd is drawn in rows this wide. */
export const MAX_ABREAST = 4;
/** Metres between neighbours walking abreast (shoulder width plus a little room; an assumption). */
export const WALK_ABREAST_SPACING_METRES = 0.9;
/** Sideways offset (metres right of travel) of the `rank`-th of `count` people walking abreast, centred on the route. */
export const abreastOffset = (rank: number, count: number): number => (rank - (count - 1) / 2) * WALK_ABREAST_SPACING_METRES;
