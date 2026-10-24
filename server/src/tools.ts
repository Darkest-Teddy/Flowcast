// The tools the Ask agent can call. Each one reads the simulation, the bundled walking routes or
// the published class schedule through map-client/src/insights.ts, the same functions the map's
// Ask tab uses, so the model words the answer but never supplies a number itself.
//
// Tools also record what the map should show (a walking route, a selected building, ranked rows)
// as one entry per call; the answer carries the `show` and `rows` of the last call that produced
// map output (see mapOutput), so the two always come from the same call.

import { tool } from '@openai/agents';
import { z } from 'zod';
import {
  busyOutlook,
  courseMentions,
  coursesFor,
  nextMeeting,
  placeMentions,
  rankByCrowd,
  walkBetween,
  type AskContext,
  type CourseMeeting,
} from '../../map-client/src/insights';
import { crowdLevel } from '../../map-client/src/layers/crowdLevels';
import { formatClock, type CampusLocation, type LocationKind } from '../../map-client/src/sim/playback';
import { WEEKDAYS } from '../../map-client/src/data/campusData';

export const PLACE_KINDS = ['library', 'dining', 'gym', 'dorm', 'classroom'] as const satisfies readonly LocationKind[];

export interface MapShow {
  /** [lng, lat] points of a walk to draw. */
  route: { path: [number, number][]; estimate: boolean } | null;
  /** Map location id to select. */
  select: string | null;
  /** Points the camera should fit. */
  points: [number, number][];
}

export interface AnswerRow {
  id: string;
  name: string;
  percent: number | null;
  level: string | null;
  students: number;
  modeled: boolean;
  walkMinutes: number | null;
}

/** What one tool call asks the map to show. */
export interface MapEntry {
  tool: string;
  show: MapShow | null;
  rows: AnswerRow[];
}

/** Collected while the agent runs. */
export interface ToolLog {
  /** Tool names in call order. */
  calls: string[];
  /** One entry per call that produced map output, in the order the calls ran. */
  map: MapEntry[];
  /** Each tool result as JSON, to check the answer's numbers against (never logged). */
  outputs: string[];
}

export const newToolLog = (): ToolLog => ({ calls: [], map: [], outputs: [] });

/** The map output of the last call that produced any; rows are empty unless that call was a ranking. */
export function mapOutput(log: ToolLog): { show: MapShow | null; rows: AnswerRow[] } {
  const last = log.map[log.map.length - 1];
  return { show: last?.show ?? null, rows: last?.rows ?? [] };
}

const percent = (share: number | null) => (share === null ? null : Math.round(share * 100));

/** "HH:MM" (24-hour) to seconds since midnight; null for anything else. */
function parseClock(value: string | null, fallback: number): number | null {
  if (!value) return fallback;
  const m = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60;
}
const badTime = (value: string | null) => ({ error: `Time must be HH:MM in 24-hour form, got "${value}".` });
const clockParam = (what: string) => z.string().regex(/^\d{2}:\d{2}$/).nullable().describe(what);

/** Full course codes a code names when it names more than one ("BI 515": CAS BI 515, WED BI 515). */
const ambiguity = (codes: string[]) => `"${codes.map((c) => c.split(' ').slice(1).join(' '))[0]}" names more than one course: ${codes.join(', ')}. Ask which one.`;

/** A place id, name, short name or course code ("CAS CS 132") to a map location. */
export function resolvePlace(ref: string, ctx: AskContext): { location: CampusLocation; label: string } | { error: string } {
  const text = ref.trim();
  const lower = text.toLowerCase();
  const exact = ctx.locations.find((l) => l.id === lower || l.name.toLowerCase() === lower || l.short.toLowerCase() === lower);
  if (exact) return { location: exact, label: exact.short };
  const course = courseMentions(text)[0];
  if (course) {
    const courses = coursesFor(course.code, ctx);
    if (courses.length > 1) return { error: ambiguity(courses.map((c) => c.courseCode)) };
    const next = nextMeeting(courses[0]?.meetings ?? [], ctx.weekday, ctx.time);
    const location = next && ctx.locations.find((l) => l.id === next.locationId);
    if (location && next) return { location, label: `${next.courseCode} (${location.short} ${next.roomCode})` };
    return { error: `No published meeting of "${text}" is in a mapped building.` };
  }
  const named = placeMentions(text, ctx.locations)[0];
  if (named) return { location: named.location, label: named.location.short };
  return { error: `No mapped place matches "${text}". Call find_places to see the names the map uses.` };
}

const meetingWhen = (m: CourseMeeting) => ({ day: WEEKDAYS[Math.floor(m.startSec / 86400) % 7], time: formatClock(m.startSec % 86400) });

export function createTools(ctx: AskContext, log: ToolLog) {
  const byId = new Map(ctx.locations.map((l) => [l.id, l]));
  const called = (name: string) => log.calls.push(name);
  /** Records a result (and, for calls that change the map, its map output) and returns it. */
  const result = <T extends object>(value: T, map?: MapEntry): T => {
    log.outputs.push(JSON.stringify(value));
    if (map && !('error' in value)) log.map.push(map);
    return value;
  };

  const findPlaces = tool({
    name: 'find_places',
    description: 'List mapped campus places, optionally filtered by kind or by a name fragment. Use it to learn the names the map uses.',
    parameters: z.object({
      kind: z.enum(PLACE_KINDS).nullable().describe('Only places of this kind, or null for all kinds.'),
      nameContains: z.string().max(60).nullable().describe('Case-insensitive fragment of the name, or null.'),
    }),
    execute: ({ kind, nameContains }) => {
      called('find_places');
      const q = nameContains?.toLowerCase();
      return result(ctx.locations
        .filter((l) => (!kind || l.kind === kind) && (!q || l.name.toLowerCase().includes(q) || l.short.toLowerCase().includes(q)))
        .slice(0, 25)
        .map((l) => ({ id: l.id, name: l.name, short: l.short, kind: l.kind, campus: l.campus ?? 'charles-river' })));
    },
  });

  const rankPlaces = tool({
    name: 'rank_places_by_crowd',
    description:
      'Rank every place of one kind on the campus in view from least to most crowded at a time, using the simulation. ' +
      'Places come sorted by exact share, so leastCrowded (the first modeled place) is the answer even when rounded percents tie; never re-rank by student count. ' +
      'percent is simulated students over stated capacity; null means the capacity is not comparable. ' +
      'modeled=false means the simulation does not model that place on this day. Optionally gives walking minutes from a place.',
    parameters: z.object({
      kind: z.enum(PLACE_KINDS),
      time: clockParam('HH:MM, 24-hour, on the shown day. Null for the time currently shown on the map.'),
      near: z.string().max(80).nullable().describe('Place name, id or course code to measure walks from, or null.'),
    }),
    execute: ({ kind, time, near }) => {
      called('rank_places_by_crowd');
      const at = parseClock(time, ctx.time);
      if (at === null) return result(badTime(time));
      const from = near ? resolvePlace(near, ctx) : null;
      if (from && 'error' in from) return result({ error: from.error });
      const ranked = rankByCrowd(ctx, kind, at, from?.location ?? null);
      const rows: AnswerRow[] = ranked.map((r) => ({
        id: r.location.id,
        name: r.location.name,
        percent: percent(r.share),
        level: r.share === null ? null : crowdLevel(r.share).label,
        students: r.count,
        modeled: r.modeled,
        walkMinutes: r.walk?.minutes ?? null,
      }));
      const best = ranked[0];
      // When the top place isn't modeled the map selects nothing, rather than keeping an earlier selection.
      const walk = best?.modeled && best.walk && best.walk.meters > 0 ? best.walk : null;
      const show: MapShow | null = best?.modeled
        ? {
            route: walk ? { path: walk.path, estimate: walk.basis === 'estimate' } : null,
            select: best.location.id,
            points: [best.location.position, ...(from ? [from.location.position] : [])],
          }
        : null;
      return result({
        day: WEEKDAYS[ctx.weekday],
        time: formatClock(at),
        from: from?.label ?? null,
        leastCrowded: best?.modeled ? best.location.name : null,
        places: ranked.map((r) => ({
          id: r.location.id,
          name: r.location.name,
          percent: percent(r.share),
          level: r.share === null ? null : crowdLevel(r.share).label,
          students: r.count,
          capacity: r.location.capacity,
          modeled: r.modeled,
          walkMinutes: r.walk?.minutes ?? null,
          walkMeters: r.walk?.meters ?? null,
          walkIsEstimate: r.walk ? r.walk.basis === 'estimate' : null,
        })),
      }, { tool: 'rank_places_by_crowd', show, rows });
    },
  });

  const walkingRoute = tool({
    name: 'walking_route',
    description:
      'Walking distance and time between two places. Each end can be a place name, id or course code; a course resolves to the building of its next meeting. ' +
      'Uses the bundled OpenStreetMap footpaths at 1.4 m/s; isEstimate=true means no footpath was mapped and the distance is straight-line × 1.3.',
    parameters: z.object({ from: z.string().max(80), to: z.string().max(80) }),
    execute: ({ from, to }) => {
      called('walking_route');
      const a = resolvePlace(from, ctx);
      if ('error' in a) return result({ error: a.error });
      const b = resolvePlace(to, ctx);
      if ('error' in b) return result({ error: b.error });
      const walk = walkBetween(a.location, b.location, ctx.walkRoutes);
      const show: MapShow = {
        route: walk.meters > 0 ? { path: walk.path, estimate: walk.basis === 'estimate' } : null,
        select: walk.meters > 0 ? null : a.location.id,
        points: [a.location.position, b.location.position],
      };
      return result(
        { from: a.label, to: b.label, sameBuilding: walk.meters === 0, meters: walk.meters, minutes: walk.minutes, isEstimate: walk.basis === 'estimate' },
        { tool: 'walking_route', show, rows: [] },
      );
    },
  });

  const findCourse = tool({
    name: 'find_course',
    description:
      'Where and when a course meets, from the published Fall 2026 class schedule. Accepts codes like "CAS CS 132" or "CS 132". ' +
      'If the code names more than one course it returns ambiguous: the full codes; ask the user which one they mean.',
    parameters: z.object({ code: z.string().max(40) }),
    execute: ({ code }) => {
      called('find_course');
      const mention = courseMentions(code)[0];
      if (!mention) return result({ error: `"${code}" doesn't look like a course code such as CAS CS 132.` });
      const courses = coursesFor(mention.code, ctx);
      if (courses.length > 1) return result({ ambiguous: courses.map((c) => c.courseCode) });
      const all = courses[0]?.meetings ?? [];
      const next = nextMeeting(all, ctx.weekday, ctx.time);
      if (!next) return result({ error: `No published meeting of ${code} is in a mapped building.` });
      const where = byId.get(next.locationId);
      const sections = new Map<string, Set<string>>();
      for (const m of all) sections.set(m.locationId, (sections.get(m.locationId) ?? new Set()).add(m.section));
      return result(
        {
          courseCode: next.courseCode,
          title: next.title,
          next: { ...meetingWhen(next), building: where?.name ?? next.locationId, room: next.roomCode, section: next.section },
          sectionsByBuilding: [...sections].map(([id, s]) => ({ building: byId.get(id)?.name ?? id, sections: s.size })),
        },
        where ? { tool: 'find_course', show: { route: null, select: where.id, points: [where.position] }, rows: [] } : undefined,
      );
    },
  });

  const placeOutlook = tool({
    name: 'place_crowd_outlook',
    description: 'How full one place is at a time in the simulation, and its quietest and busiest hours for the rest of the shown day.',
    parameters: z.object({
      place: z.string().max(80).describe('Place name, id or course code.'),
      time: clockParam('HH:MM, 24-hour, or null for the time shown on the map.'),
    }),
    execute: ({ place, time }) => {
      called('place_crowd_outlook');
      const p = resolvePlace(place, ctx);
      if ('error' in p) return result({ error: p.error });
      const at = parseClock(time, ctx.time);
      if (at === null) return result(badTime(time));
      const o = busyOutlook(ctx, p.location, at);
      const students = ctx.occupancyAt(at).find((x) => x.location.id === p.location.id)?.count ?? 0;
      return result({
        place: p.location.name,
        day: WEEKDAYS[ctx.weekday],
        time: formatClock(at),
        modeled: o.modeled,
        students,
        percentNow: percent(o.now),
        quietestLater: o.quiet && { time: formatClock(o.quiet.time), percent: percent(o.quiet.share) },
        busiestLater: o.busy && { time: formatClock(o.busy.time), percent: percent(o.busy.share) },
      }, { tool: 'place_crowd_outlook', show: { route: null, select: p.location.id, points: [p.location.position] }, rows: [] });
    },
  });

  return [findPlaces, rankPlaces, walkingRoute, findCourse, placeOutlook];
}
