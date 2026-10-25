import { departureAnswer } from '../../lib/departureAnswer';
import { crowdFor } from '@theme/tokens';
import { locationName } from '../../data/api';
import type {
  CampusEvent,
  CampusGeo,
  CampusLocation,
  Club,
  HourlyForecast,
  LocationKind,
  PlaceForecast,
  ScheduleItem,
} from '../../data/types';
import { formatDayTime, formatHour, formatMeters, formatPercent, formatTime } from '../../lib/format';
import { interpret, type InsightData, type Walk } from '../../lib/insights';
import type { AgentAnswer } from '@map/askClient';

export interface CampusData {
  locations: CampusLocation[];
  schedule: ScheduleItem[];
  events: CampusEvent[];
  clubs: Club[];
  hourly: HourlyForecast[];
  places: PlaceForecast[];
  geo: CampusGeo;
  homeLocationId: string | null;
}

export interface SearchResult {
  id: string;
  kind: 'Place' | 'Your day' | 'Event' | 'Club';
  title: string;
  detail: string;
  to: string;
}

const kindLabel: Record<LocationKind, string> = {
  dorm: 'Residence hall',
  classroom: 'Academic building',
  library: 'Library',
  dining: 'Dining hall',
  gym: 'Gym',
  venue: 'Venue',
};

const describe = (share: number) => `${formatPercent(share)} ${crowdFor(share).label.toLowerCase()}`;

/** Plain substring search over places, the person's day, events and clubs. */
export function searchCampus(query: string, d: CampusData): SearchResult[] {
  const q = query.toLowerCase();
  const has = (...fields: (string | undefined)[]) => fields.some((f) => f?.toLowerCase().includes(q));
  const results: SearchResult[] = [];

  for (const loc of d.locations) {
    if (!has(loc.name, loc.short)) continue;
    const forecast = d.hourly.some((h) => h.locationId === loc.id);
    results.push({ id: `place-${loc.id}`, kind: 'Place', title: loc.name, detail: kindLabel[loc.kind], to: forecast ? `/forecasts?place=${loc.id}` : '/forecasts' });
  }
  for (const item of d.schedule) {
    if (!has(item.title, locationName(d.locations, item.locationId, false))) continue;
    results.push({ id: `day-${item.id}`, kind: 'Your day', title: item.title, detail: formatDayTime(item.start), to: '/schedule' });
  }
  for (const ev of d.events) {
    if (!has(ev.title, ev.venue ?? '', ev.organizer ?? '')) continue;
    results.push({ id: `event-${ev.id}`, kind: 'Event', title: ev.title, detail: formatDayTime(ev.start), to: `/event-impact?date=${ev.start.slice(0, 10)}` });
  }
  for (const club of d.clubs) {
    if (!club.verified || !has(club.name, club.description)) continue;
    results.push({ id: `club-${club.id}`, kind: 'Club', title: club.name, detail: club.members == null ? 'Published event organizer' : `${club.members} members`, to: '/clubs' });
  }
  return results;
}

export interface AnswerRow {
  id: string;
  title: string;
  detail: string;
  share?: number | null;
}

/** What Ask Flowcast shows: one plain sentence, optional rows to compare, and places to show on the map. */
export interface Answer {
  text: string;
  rows: AnswerRow[];
  note?: string;
  /** Location ids the answer is about, for "Show on map". */
  focus: string[];
  /** The same question in the map's terms, asked in its Ask tab. Holds place ids and kinds, never class titles. */
  mapQuestion?: string;
  /** Set when the answer was worked out on this device, saying why in plain words. */
  device?: string;
}

const AGENT_NOTE = 'Simulated students over each place’s stated capacity, on the modeled schedule for this weekday. Not a live count.';

/**
 * The Ask server's answer in Ask Flowcast's layout. Row ids are the map's place ids, so "Show on map"
 * asks the map the same question rather than focusing ids. Only campus questions get here.
 */
export function agentAnswer(result: AgentAnswer, question: string): Answer {
  const rows: AnswerRow[] = result.rows.map((r) => {
    const share = r.open === false || r.percent === null ? null : r.percent / 100;
    const state = !r.modeled ? 'Not modeled'
      : r.open === false ? 'Closed'
      : share === null ? `${r.students.toLocaleString()} simulated students`
      : `${formatPercent(share)} ${(r.level ?? crowdFor(share).label).toLowerCase()}`;
    const detail = [state, r.modeled && r.open === null ? 'hours not published' : '', r.walkMinutes === null ? '' : r.walkMinutes === 0 ? 'you are here' : `${r.walkMinutes} min walk`];
    return { id: r.id, title: r.name, detail: detail.filter(Boolean).join(' · '), share };
  });
  return {
    text: result.answer,
    rows,
    note: rows.some((r) => r.share !== null) ? AGENT_NOTE : undefined,
    focus: [],
    mapQuestion: question,
  };
}

export const EXAMPLE_QUESTIONS = [
  'Where is my next class?',
  'Least crowded library right now',
  'How far is CS 132 from DS 340?',
  'Quietest dining hall at 6pm',
  'How far apart are my classes today?',
];

const PROJECTION_NOTE = 'Crowd levels are model projections from stated assumptions, not live counts of people.';

const kindPlural: Record<LocationKind, string> = {
  dorm: 'residence halls',
  classroom: 'academic buildings',
  library: 'libraries',
  dining: 'dining halls',
  gym: 'gyms',
  venue: 'venues',
};

/** How the map's Ask tab names each kind of place. */
const mapKindWord: Record<LocationKind, string> = {
  dorm: 'dorm',
  classroom: 'classroom',
  library: 'library',
  dining: 'dining hall',
  gym: 'gym',
  venue: 'gym',
};

const walkText = (w: Walk) =>
  w.meters === 0
    ? 'no walk at all, same building'
    : w.basis === 'route'
      ? `${w.minutes}-minute walk (${formatMeters(w.meters)})`
      : `walk of about ${w.minutes} minutes (roughly ${formatMeters(w.meters)}, estimated from straight-line distance)`;

const walkShort = (w: Walk | null) => (!w ? 'no walking data' : w.meters === 0 ? 'you are here' : `${w.basis === 'route' ? '' : '~'}${w.minutes} min walk`);


/** Ask Flowcast: next class, least crowded place of a kind, walking distance, or how busy a place gets. */
export function answerQuestion(query: string, d: CampusData, now = new Date()): Answer {
  const data: InsightData = { locations: d.locations, schedule: d.schedule, hourly: d.hourly, geo: d.geo, homeLocationId: d.homeLocationId };
  const name = (id: string) => locationName(d.locations, id, false);
  const short = (id: string) => locationName(d.locations, id);
  if (/\bwhen (?:should|must|can|do) i (?:need to )?(?:leave|depart|head out)\b|\bam i late\b|\bcan i make it\b|\bleave.by time\b/i.test(query)) {
    return departureAnswer(d.schedule, d.locations, d.geo, d.homeLocationId, now.getTime());
  }
  const insight = interpret(query, data, now);

  switch (insight.kind) {
    case 'nextClass':
    case 'noNextClass':
      return departureAnswer(d.schedule, d.locations, d.geo, d.homeLocationId, now.getTime());
    case 'leastCrowded': {
      const { placeKind, at, ranked, from } = insight;
      const when = Math.abs(at.getTime() - now.getTime()) < 60_000 ? 'right now' : `at ${formatTime(at.toISOString())}`;
      const rows = ranked.map((r) => ({
        id: r.locationId,
        title: name(r.locationId),
        detail: [r.share === null ? 'No projection' : describe(r.share), walkShort(r.walk)].join(' · '),
        share: r.share,
      }));
      if (!ranked.length) return { text: `Flowcast doesn't know any ${kindPlural[placeKind]} yet.`, rows: [], focus: [] };
      const best = ranked[0];
      const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
      const mapQuestion = `least crowded ${mapKindWord[placeKind]}${when === 'right now' ? '' : ` at ${hhmm}`}`;
      if (best.share === null) {
        return { text: `Flowcast has no crowd projection for ${kindPlural[placeKind]} ${when}. Only modeled hours with usable capacity and opening-hour data are compared.`, rows, focus: ranked.map((r) => r.locationId), mapQuestion };
      }
      const walk = best.walk && best.walk.meters > 0 && from ? `, a ${walkText(best.walk)} from ${from.label}` : '';
      return {
        text: `${name(best.locationId)} is the least crowded of the ${kindPlural[placeKind]} ${when}: projected ${describe(best.share)}${walk}.`,
        rows,
        note: PROJECTION_NOTE,
        focus: [best.locationId],
        mapQuestion,
      };
    }
    case 'distance': {
      const { legs } = insight;
      const legText = (l: (typeof legs)[number]) =>
        l.walk ? `${l.from.label} to ${l.to.label} is a ${walkText(l.walk)}.` : `Flowcast has no walking data between ${short(l.from.locationId)} and ${short(l.to.locationId)} yet.`;
      const focus = [...new Set(legs.flatMap((l) => [l.from.locationId, l.to.locationId]))];
      const mapQuestion = `how far is ${legs[0].from.locationId} from ${legs[0].to.locationId}`;
      if (legs.length === 1) return { text: legText(legs[0]), rows: [], focus, mapQuestion };
      const total = legs.reduce((m, l) => m + (l.walk?.minutes ?? 0), 0);
      return {
        text: `That's ${legs.length} walks, about ${total} minutes in all.`,
        rows: legs.map((l, k) => ({ id: `leg${k}`, title: `${l.from.label} → ${l.to.label}`, detail: walkShort(l.walk) })),
        focus,
        mapQuestion,
      };
    }
    case 'needTwoPlaces':
      return { text: 'Name two places or classes, for example “how far is CAS from Mugar?”', rows: [], focus: [] };
    case 'busy':
      return busyAnswer(insight.locationId, d, now);
    case 'unknown':
      return {
        text: 'Flowcast can answer things like “where is my next class?”, “least crowded library” or “how far is CS 132 from DS 340?”. You can also name a place to see when it gets busy.',
        rows: [],
        focus: [],
      };
  }
}

function busyAnswer(locationId: string, d: CampusData, now: Date): Answer {
  const loc = d.locations.find((l) => l.id === locationId)!;
  const focus = [loc.id];
  const mapQuestion = `when is ${loc.id} quiet`;
  const hourly = d.hourly.find((h) => h.locationId === loc.id);
  if (hourly && hourly.hours.length) {
    const ahead = hourly.hours.filter((h) => h.hour >= now.getHours());
    const hours = ahead.length ? ahead : hourly.hours;
    const quiet = hours.reduce((a, b) => (b.share < a.share ? b : a));
    const busy = hours.reduce((a, b) => (b.share > a.share ? b : a));
    const when = ahead.length ? 'for the rest of today' : 'today';
    return {
      text: `${loc.short} is projected to be quietest at ${formatHour(quiet.hour)} (${describe(quiet.share)}) and busiest at ${formatHour(busy.hour)} (${describe(busy.share)}) ${when}.`,
      rows: [],
      note: PROJECTION_NOTE,
      focus,
      mapQuestion,
    };
  }
  const place = d.places.find((p) => p.locationId === loc.id);
  if (place) return { text: `${loc.short} is projected to be ${describe(place.share)} at ${formatTime(place.at)}.`, rows: [], note: PROJECTION_NOTE, focus, mapQuestion };
  return { text: `There is no crowd projection for ${loc.name} yet.`, rows: [], focus, mapQuestion };
}
