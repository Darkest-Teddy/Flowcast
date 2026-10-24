// Answers to the practical questions students ask the map: where is my next class, which library
// is least crowded, how far apart are two places. Pure and deterministic: the caller passes `now`.
//
// Crowd levels come from the model-derived hourly projections, not counts of real people.
// Walking distances come from the map's bundled OpenStreetMap pedestrian routes; when a pair has no
// route, the straight-line distance is stretched by a stated detour factor and labelled as such.

import type { CampusGeo, CampusLocation, HourlyForecast, LocationKind, ScheduleItem } from '../data/types';

export const INSIGHT_ASSUMPTIONS = {
  /** Walking speed, m/s. Same default the map's agents use (map-client/src/sim/sourceDay.ts). */
  walkSpeedMps: 1.4,
  /** Street distance over straight-line distance when no bundled route exists. A common urban rule of thumb. */
  detourFactor: 1.3,
} as const;

export interface Walk {
  fromId: string;
  toId: string;
  meters: number;
  minutes: number;
  /** 'route' follows a bundled pedestrian route; 'estimate' is straight line times the detour factor. */
  basis: 'route' | 'estimate';
}

/** A place the person referred to, by its own name or by something held there (a class). */
export interface PlaceRef {
  locationId: string;
  label: string; // what to call it in the answer: "DS 340 (CDS)" or "Mugar"
}

export interface RankedPlace {
  locationId: string;
  /** Projected occupancy / capacity at the asked time, or null when there is no projection. */
  share: number | null;
  walk: Walk | null;
}

export type Insight =
  | { kind: 'nextClass'; item: ScheduleItem; inProgress: ScheduleItem | null; from: PlaceRef | null; walk: Walk | null }
  | { kind: 'noNextClass' }
  | { kind: 'leastCrowded'; placeKind: LocationKind; at: Date; ranked: RankedPlace[]; from: PlaceRef | null }
  | { kind: 'distance'; legs: { from: PlaceRef; to: PlaceRef; walk: Walk | null }[] }
  | { kind: 'needTwoPlaces' }
  | { kind: 'busy'; locationId: string }
  | { kind: 'unknown' };

export interface InsightData {
  locations: CampusLocation[];
  schedule: ScheduleItem[];
  hourly: HourlyForecast[];
  geo: CampusGeo;
  homeLocationId: string | null;
}

const MINUTE = 60_000;

// ---------------------------------------------------------------- walking

/** Great-circle distance in meters between two [lng, lat] points. */
export function haversineMeters([lng1, lat1]: [number, number], [lng2, lat2]: [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

export function walkBetween(fromId: string, toId: string, geo: CampusGeo, a = INSIGHT_ASSUMPTIONS): Walk | null {
  const done = (meters: number, basis: Walk['basis']): Walk => ({
    fromId,
    toId,
    meters: Math.round(meters),
    minutes: Math.max(1, Math.round(meters / a.walkSpeedMps / 60)),
    basis,
  });
  if (fromId === toId) return { fromId, toId, meters: 0, minutes: 0, basis: 'route' };
  const key = [fromId, toId].sort().join('>');
  const routed = geo.walkMeters[key];
  if (routed !== undefined) return done(routed, 'route');
  const p = geo.positions[fromId];
  const q = geo.positions[toId];
  if (!p || !q) return null;
  return done(haversineMeters(p, q) * a.detourFactor, 'estimate');
}

// ---------------------------------------------------------------- schedule

/** Items the person will actually attend: everything except suggestions they haven't accepted. */
const attended = (items: ScheduleItem[]) =>
  items
    .filter((i) => i.source !== 'suggested' || i.accepted)
    .sort((x, y) => Date.parse(x.start) - Date.parse(y.start));

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const isClass = (i: ScheduleItem) => i.source === 'calendar';

/** The class in progress at `now` (if any) and the next class to start after it. */
export function nextClass(schedule: ScheduleItem[], now: Date): { item: ScheduleItem | null; inProgress: ScheduleItem | null } {
  const t = now.getTime();
  const classes = attended(schedule).filter(isClass);
  const inProgress = classes.find((i) => Date.parse(i.start) <= t && t < Date.parse(i.end)) ?? null;
  const item = classes.find((i) => Date.parse(i.start) > t) ?? null;
  return { item, inProgress };
}

/**
 * Where the person is at `at`: the item in progress, else the last item that ended earlier the
 * same day, else home. `exclude` skips an item (the one being travelled to).
 */
export function placeAt(d: InsightData, at: Date, exclude?: string): PlaceRef | null {
  const t = at.getTime();
  const items = attended(d.schedule).filter((i) => i.id !== exclude && sameDay(new Date(i.start), at));
  const current = items.find((i) => Date.parse(i.start) <= t && t < Date.parse(i.end));
  const before = [...items].reverse().find((i) => Date.parse(i.end) <= t);
  const item = current ?? before;
  if (item) return { locationId: item.locationId, label: `${item.title} (${shortName(d, item.locationId)})` };
  if (d.homeLocationId) return { locationId: d.homeLocationId, label: shortName(d, d.homeLocationId) };
  return null;
}

const shortName = (d: InsightData, id: string) => d.locations.find((l) => l.id === id)?.short ?? id;

// ---------------------------------------------------------------- crowding

/** Projected share at the hour containing `at`, from a forecast for that same local day. */
export function shareAt(hourly: HourlyForecast[], locationId: string, at: Date): number | null {
  const f = hourly.find((h) => h.locationId === locationId && sameDay(new Date(h.day), at));
  return f?.hours.find((h) => h.hour === at.getHours())?.share ?? null;
}

/** Places of one kind, quietest first; places without a projection go last. */
export function rankByCrowd(d: InsightData, placeKind: LocationKind, at: Date, fromId: string | null): RankedPlace[] {
  return d.locations
    .filter((l) => l.kind === placeKind)
    .map((l) => ({
      locationId: l.id,
      share: shareAt(d.hourly, l.id, at),
      walk: fromId ? walkBetween(fromId, l.id, d.geo) : null,
    }))
    .sort((x, y) => {
      if (x.share === null || y.share === null) return x.share === null ? (y.share === null ? 0 : 1) : -1;
      if (x.share !== y.share) return x.share - y.share;
      return (x.walk?.meters ?? Infinity) - (y.walk?.meters ?? Infinity);
    });
}

// ---------------------------------------------------------------- question parsing

/** Lowercase, punctuation to spaces, and "cs 132" joined to "cs132" so class codes match either way. */
export function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b([a-z]{2,4}) (\d{2,3})\b/g, '$1$2').trim()} `;
}

/** Places mentioned in the question, in the order they appear. Class titles resolve to their building. */
export function findPlaces(query: string, d: InsightData, now: Date): PlaceRef[] {
  const q = normalize(query);
  const candidates: { needle: string; ref: PlaceRef }[] = [];
  for (const l of d.locations) {
    for (const n of new Set([l.name, l.short, l.id])) candidates.push({ needle: normalize(n), ref: { locationId: l.id, label: l.short } });
  }
  // A class title can repeat across the week; use the next meeting (or the latest one if all are past).
  const byTitle = new Map<string, ScheduleItem>();
  for (const item of attended(d.schedule).filter((i) => i.source === 'calendar' || i.source === 'club')) {
    const seen = byTitle.get(item.title);
    if (!seen || (Date.parse(seen.end) < now.getTime() && Date.parse(item.end) >= now.getTime())) byTitle.set(item.title, item);
  }
  for (const item of byTitle.values()) {
    candidates.push({ needle: normalize(item.title), ref: { locationId: item.locationId, label: `${item.title} (${shortName(d, item.locationId)})` } });
  }

  const hits: { at: number; len: number; ref: PlaceRef }[] = [];
  for (const c of candidates) {
    if (c.needle.trim().length < 3) continue;
    for (let at = q.indexOf(c.needle); at !== -1; at = q.indexOf(c.needle, at + 1)) hits.push({ at, len: c.needle.length, ref: c.ref });
  }
  // Longest match wins where matches overlap ("warren dining" over "warren").
  hits.sort((x, y) => x.at - y.at || y.len - x.len);
  const picked: typeof hits = [];
  for (const h of hits) {
    const last = picked[picked.length - 1];
    if (last && h.at < last.at + last.len - 1) {
      if (h.len > last.len) picked[picked.length - 1] = h;
      continue;
    }
    picked.push(h);
  }
  return picked.map((h) => h.ref);
}

const KIND_WORDS: [RegExp, LocationKind][] = [
  [/\b(librar(y|ies)|study|studying)\b/, 'library'],
  [/\b(dining|dining halls?|food|eat|eating|lunch|dinner|breakfast|meal)\b/, 'dining'],
  [/\b(gym|gyms|workout|work out|lift)\b/, 'gym'],
  [/\b(dorms?|residence|residence halls?)\b/, 'dorm'],
];

/** "at 3pm", "3:30 pm", "noon", "tonight": a time today. Null when the question names no time. */
export function parseTime(query: string, now: Date): Date | null {
  const q = query.toLowerCase();
  const at = (h: number, m = 0) => {
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    return d;
  };
  const m = q.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (m) {
    const h = Number(m[1]) % 12 + (m[3] === 'pm' ? 12 : 0);
    return at(h, Number(m[2] ?? 0));
  }
  if (/\bnoon\b/.test(q)) return at(12);
  if (/\btonight\b|\bthis evening\b/.test(q)) return at(20);
  if (/\bthis afternoon\b/.test(q)) return at(14);
  if (/\bthis morning\b/.test(q)) return at(9);
  return null;
}

/** Work out what the question asks and compute the answer's facts. Wording is left to the UI. */
export function interpret(query: string, d: InsightData, now: Date): Insight {
  const q = ` ${query.toLowerCase()} `;
  const places = findPlaces(query, d, now);

  const asksDistance = /\bhow far\b|\bdistance\b|\bhow long\b.*\bwalk\b|\bwalk(ing)?\b.*\b(to|from|between)\b|\bfar apart\b|\bminutes? (from|to|between)\b/.test(q);
  const mentionsNextClass = /\bnext (class|lecture|section|lab)\b|\bwhere('s| is) my (class|next)\b|\bwhat('s| is) next\b/.test(q);
  const asksQuietest = /\b(least|less) (crowded|busy|full|packed)\b|\bquiet(est|er)?\b|\bemptiest\b|\bleast people\b|\bnot (crowded|busy)\b|\bfree(st)? (seat|space)s?\b/.test(q);
  const placeKind = KIND_WORDS.find(([re]) => re.test(q))?.[1];

  if (asksDistance) {
    if (/\bmy classes\b|\bbetween classes\b/.test(q) && places.length < 2) {
      const today = attended(d.schedule).filter((i) => isClass(i) && sameDay(new Date(i.start), now));
      const legs = today.slice(1).map((to, k) => {
        const from = today[k];
        return {
          from: { locationId: from.locationId, label: `${from.title} (${shortName(d, from.locationId)})` },
          to: { locationId: to.locationId, label: `${to.title} (${shortName(d, to.locationId)})` },
          walk: walkBetween(from.locationId, to.locationId, d.geo),
        };
      });
      return legs.length ? { kind: 'distance', legs } : { kind: 'needTwoPlaces' };
    }
    let stops = places;
    if (mentionsNextClass) {
      const next = nextClass(d.schedule, now).item;
      if (!next) return { kind: 'noNextClass' };
      stops = [...places, { locationId: next.locationId, label: `${next.title} (${shortName(d, next.locationId)})` }];
    }
    if (stops.length === 1) {
      const here = placeAt(d, now);
      if (here && here.locationId !== stops[0].locationId) stops = [here, stops[0]];
    }
    if (stops.length < 2) return { kind: 'needTwoPlaces' };
    const legs = stops.slice(1).map((to, k) => ({ from: stops[k], to, walk: walkBetween(stops[k].locationId, to.locationId, d.geo) }));
    return { kind: 'distance', legs };
  }

  if (mentionsNextClass || (/\bclass\b/.test(q) && /\bwhere\b|\bwhen\b|\bnext\b/.test(q) && !places.length)) {
    const { item, inProgress } = nextClass(d.schedule, now);
    if (!item) return { kind: 'noNextClass' };
    const from = placeAt(d, new Date(Date.parse(item.start) - MINUTE), item.id) ?? null;
    const walk = from ? walkBetween(from.locationId, item.locationId, d.geo) : null;
    return { kind: 'nextClass', item, inProgress, from, walk };
  }

  if (asksQuietest && placeKind && !places.length) {
    const at = parseTime(query, now) ?? now;
    const from = placeAt(d, at);
    return { kind: 'leastCrowded', placeKind, at, ranked: rankByCrowd(d, placeKind, at, from?.locationId ?? null), from };
  }

  if (places.length) return { kind: 'busy', locationId: places[0].locationId };
  if (placeKind) {
    const at = parseTime(query, now) ?? now;
    const from = placeAt(d, at);
    return { kind: 'leastCrowded', placeKind, at, ranked: rankByCrowd(d, placeKind, at, from?.locationId ?? null), from };
  }
  return { kind: 'unknown' };
}
