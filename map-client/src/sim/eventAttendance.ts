// Expected attendance at venue events (Agganis Arena, Walter Brown, Case Gym, Fenway Park, MGM
// Music Hall), from venue capacity and the event's public popularity, and how the crowd arrives and
// leaves. Deterministic: the same calendar, popularity file and sim time always give the same
// numbers, at any playback speed.
//
//   expected attendance = capacity x fill
//   fill = base x (score / reference) ^ elasticity, clamped to capacity
//
// `score` is the event's Google Trends score (data-pipeline/event_popularity.py: Boston-area search
// interest over the 90 days before it, TD Garden = 100) and `reference` the median score of its kind
// group, so a typical event of its kind fills to `base`. `base` and `elasticity` are documented
// priors per kind, replaced by the pipeline's fit when past events with published attendance (box
// scores) calibrate them. Events Trends couldn't score use the prior fill with a wider range.
// A sold-out listing fills to capacity; a past event with published attendance uses that figure.
//
// Attendees are split into students and visitors (everyone else). Visitors are a separate
// population: they never enter student counts or occupancy, which stay the simulated roster.
import type { CalendarEvent, EventKind, EventPopularity, EventPopularityData, EventSources, EventVenue, VisitorOrigin } from '../data/eventCalendar';

const MIN = 60;
const DAY = 86400;
/** z for an 80% interval. */
const Z80 = 1.2816;

export interface KindModel {
  label: string;
  /** Prior median share of capacity that attends. */
  fill: number;
  /** Prior spread of fill (log-normal sd) without a popularity score. */
  fillSd: number;
  /** Share of attendees who are BU students: [low, typical, high]. */
  studentShare: [number, number, number];
  /** Typical published start to end, minutes. */
  durationMin: number;
  /** Arrivals at the door: first `leadMin` before start, busiest at start + `peakMin`, last at start + `tailMin`. */
  leadMin: number;
  peakMin: number;
  tailMin: number;
  /** Share who leave in the last `earlyWindowMin` before the end (the rest leave in the surge after it). */
  earlyLeave: number;
  earlyWindowMin: number;
  basis: string;
}

/** Documented priors by event kind. Shares and timings are assumptions, not measurements. */
export const KIND_MODELS: Record<EventKind, KindModel> = {
  'bu-hockey': { label: 'BU men’s hockey', fill: 0.82, fillSd: 0.2, studentShare: [0.2, 0.3, 0.4], durationMin: 150, leadMin: 90, peakMin: -10, tailMin: 20, earlyLeave: 0.1, earlyWindowMin: 30,
    basis: 'BU men’s hockey at Agganis Arena (6,150 for hockey); students fill the student sections behind one goal, the rest are alumni, families and Boston hockey fans.' },
  'bu-womens-hockey': { label: 'BU women’s hockey', fill: 0.15, fillSd: 0.4, studentShare: [0.3, 0.45, 0.6], durationMin: 135, leadMin: 60, peakMin: -10, tailMin: 20, earlyLeave: 0.1, earlyWindowMin: 30,
    basis: 'BU women’s hockey at Walter Brown Arena (3,806); crowds of a few hundred to a thousand.' },
  'bu-basketball': { label: 'BU men’s basketball', fill: 0.4, fillSd: 0.4, studentShare: [0.3, 0.4, 0.55], durationMin: 120, leadMin: 60, peakMin: -10, tailMin: 20, earlyLeave: 0.1, earlyWindowMin: 20,
    basis: 'BU men’s basketball at Case Gym (1,800).' },
  'bu-womens-basketball': { label: 'BU women’s basketball', fill: 0.25, fillSd: 0.4, studentShare: [0.25, 0.35, 0.5], durationMin: 120, leadMin: 60, peakMin: -10, tailMin: 20, earlyLeave: 0.1, earlyWindowMin: 20,
    basis: 'BU women’s basketball at Case Gym (1,800).' },
  'bu-soccer': { label: 'BU soccer', fill: 0.05, fillSd: 0.5, studentShare: [0.3, 0.45, 0.6], durationMin: 120, leadMin: 45, peakMin: -5, tailMin: 30, earlyLeave: 0.15, earlyWindowMin: 30,
    basis: 'BU soccer at Nickerson Field (9,871): a few hundred spectators.' },
  'bu-lacrosse': { label: 'BU lacrosse', fill: 0.05, fillSd: 0.5, studentShare: [0.3, 0.45, 0.6], durationMin: 120, leadMin: 45, peakMin: -5, tailMin: 30, earlyLeave: 0.15, earlyWindowMin: 30,
    basis: 'BU lacrosse at Nickerson Field (9,871).' },
  'bu-field-hockey': { label: 'BU field hockey', fill: 0.1, fillSd: 0.5, studentShare: [0.3, 0.45, 0.6], durationMin: 105, leadMin: 45, peakMin: -5, tailMin: 30, earlyLeave: 0.15, earlyWindowMin: 30,
    basis: 'BU field hockey at New Balance Field.' },
  'bu-sport': { label: 'BU athletics', fill: 0.1, fillSd: 0.5, studentShare: [0.3, 0.45, 0.6], durationMin: 120, leadMin: 45, peakMin: -5, tailMin: 30, earlyLeave: 0.15, earlyWindowMin: 30,
    basis: 'Other BU home games.' },
  concert: { label: 'Concert', fill: 0.8, fillSd: 0.22, studentShare: [0.05, 0.12, 0.25], durationMin: 180, leadMin: 75, peakMin: 15, tailMin: 90, earlyLeave: 0.06, earlyWindowMin: 30,
    basis: 'Touring concert: most of the crowd comes from across Greater Boston; arrivals run from doors through the opener to the headliner.' },
  comedy: { label: 'Comedy', fill: 0.75, fillSd: 0.25, studentShare: [0.05, 0.1, 0.2], durationMin: 120, leadMin: 75, peakMin: -10, tailMin: 20, earlyLeave: 0.04, earlyWindowMin: 20,
    basis: 'Touring comedy show.' },
  pwhl: { label: 'PWHL hockey', fill: 0.6, fillSd: 0.3, studentShare: [0.02, 0.05, 0.1], durationMin: 150, leadMin: 75, peakMin: -10, tailMin: 20, earlyLeave: 0.08, earlyWindowMin: 30,
    basis: 'Boston Fleet (PWHL) home game.' },
  family: { label: 'Family show', fill: 0.55, fillSd: 0.3, studentShare: [0.01, 0.03, 0.06], durationMin: 120, leadMin: 60, peakMin: -15, tailMin: 15, earlyLeave: 0.05, earlyWindowMin: 20,
    basis: 'Family show (ice shows, circus, monster trucks): families from the region.' },
  mlb: { label: 'Red Sox', fill: 0.87, fillSd: 0.12, studentShare: [0.01, 0.02, 0.04], durationMin: 190, leadMin: 120, peakMin: -20, tailMin: 45, earlyLeave: 0.15, earlyWindowMin: 45,
    basis: 'Red Sox home game at Fenway Park (37,755 night / 37,305 day); recent seasons average about 87% of capacity.' },
  ceremony: { label: 'Ceremony', fill: 0.85, fillSd: 0.2, studentShare: [0.2, 0.25, 0.35], durationMin: 150, leadMin: 90, peakMin: -20, tailMin: 10, earlyLeave: 0.03, earlyWindowMin: 20,
    basis: 'Graduation or convocation: graduates plus about three guests each.' },
  theatre: { label: 'Show', fill: 0.5, fillSd: 0.35, studentShare: [0.1, 0.2, 0.4], durationMin: 150, leadMin: 60, peakMin: -10, tailMin: 10, earlyLeave: 0.03, earlyWindowMin: 20,
    basis: 'Staged show.' },
  campus: { label: 'Campus event', fill: 0, fillSd: 0, studentShare: [1, 1, 1], durationMin: 120, leadMin: 30, peakMin: -5, tailMin: 10, earlyLeave: 0, earlyWindowMin: 10,
    basis: 'Student event: its students are simulated as a campus gathering; no visitors are modelled.' },
  other: { label: 'Event', fill: 0.5, fillSd: 0.4, studentShare: [0.05, 0.15, 0.3], durationMin: 150, leadMin: 75, peakMin: -15, tailMin: 20, earlyLeave: 0.05, earlyWindowMin: 20,
    basis: 'Other ticketed event.' },
};

/** Kind groups the popularity pipeline calibrates together (event_popularity.py KIND_GROUP). */
export const KIND_GROUP: Record<EventKind, string> = {
  'bu-hockey': 'bu-hockey', 'bu-womens-hockey': 'bu-sport', 'bu-basketball': 'bu-sport', 'bu-womens-basketball': 'bu-sport',
  'bu-soccer': 'bu-sport', 'bu-lacrosse': 'bu-sport', 'bu-field-hockey': 'bu-sport', 'bu-sport': 'bu-sport',
  concert: 'concert', comedy: 'concert', family: 'concert', theatre: 'concert', other: 'concert',
  pwhl: 'pwhl', mlb: 'mlb', ceremony: 'ceremony', campus: 'campus',
};

/** How strongly fill follows popularity before calibration: twice the searches, about 19% fuller. */
export const DEFAULT_ELASTICITY = 0.25;
/** Spread of fill (share of the kind's prior spread) once a popularity score is known but nothing calibrated it. */
export const SCORED_SD_SHARE = 0.85;
/** Score ratios are clamped here so one viral term can't fill an arena from nothing. */
const RELATIVE_RANGE: [number, number] = [0.1, 10];
const MIN_FILL = 0.02;
/** Sold-out listings fill to this share (comps and no-shows aside), range to capacity. */
const SOLD_OUT_FILL: [number, number, number] = [0.95, 0.98, 1];

/** How visitors reach a venue (share of visitors). Assumptions: no published mode split. */
export const MODE_SHARES: Record<string, { transit: number; parking: number; rideshare: number; basis: string }> = {
  west: { transit: 0.45, parking: 0.4, rideshare: 0.15, basis: 'West Campus venues: Green Line B at Babcock and Amory Streets, BU garages and lots, rideshare on Comm Ave.' },
  fenway: { transit: 0.55, parking: 0.3, rideshare: 0.15, basis: 'Fenway: Kenmore, Fenway and Lansdowne stations, the Lansdowne and Ipswich garages and nearby lots, rideshare on Brookline Ave.' },
};
const VENUE_AREA: Record<string, keyof typeof MODE_SHARES> = { agganis: 'west', 'walter-brown': 'west', 'case-gym': 'west', nickerson: 'west', 'new-balance-field': 'west', 'fenway-park': 'fenway', 'mgm-music-hall': 'fenway' };
/** People per car for parking demand (assumption: event parties of two or three). */
export const PEOPLE_PER_CAR = 2.4;
/** Garages without a published capacity weigh as this many spaces. */
const UNKNOWN_GARAGE_SPACES = 250;

export type EventPhase = 'arriving' | 'in' | 'leaving';

export interface PopularityEstimate {
  source: 'trends' | 'prior' | 'sold-out' | 'published';
  score: number | null;
  /** Score / its kind group's median score (1 = a typical event of its kind). */
  relative: number | null;
  reference: number | null;
  calibrated: boolean;
  /** Daily search series of the term the score rests on, for a sparkline. */
  series: number[] | null;
  scoreTerm: string | null;
  terms: string[];
  window: { from: string; to: string } | null;
  note: string;
}

export interface VenueEventEstimate {
  event: CalendarEvent;
  venue: EventVenue;
  model: KindModel;
  capacity: number;
  capacitySetup: string;
  popularity: PopularityEstimate;
  fill: number;
  fillRange: [number, number];
  attendees: number;
  attendeesRange: [number, number];
  studentShare: number;
  students: number;
  visitors: number;
  visitorsRange: [number, number];
  /** Local seconds on the event's day. */
  startSec: number;
  endSec: number;
  endEstimated: boolean;
  /** First arrival and last departure at the door (before walks to and from transit). */
  arrivalFrom: number;
  arrivalPeak: number;
  arrivalTo: number;
  departureFrom: number;
  departureTo: number;
  modes: { transit: number; parking: number; rideshare: number };
  provenance: string[];
}

export interface EventLoad {
  eventId: string;
  name: string;
  /** Inside the venue now. */
  attendees: number;
  visitors: number;
  students: number;
  phase: EventPhase;
  /** Visitors walking between the venue and their station, garage or drop-off now (estimate). */
  visitorsWalking: number;
}

/** Local seconds since midnight from an ISO timestamp that carries Boston's offset. */
export function localSeconds(iso: string): number {
  const match = /T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(iso);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? 0) : NaN;
}

// Triangular distribution on [a, b] with mode c: closed-form CDF, so shares are exact at any t.
export function triangularCdf(x: number, a: number, c: number, b: number): number {
  if (x <= a) return 0;
  if (x >= b) return 1;
  if (x <= c) return c === a ? 0 : ((x - a) ** 2) / ((b - a) * (c - a));
  return b === c ? 1 : 1 - ((b - x) ** 2) / ((b - a) * (b - c));
}
export function triangularQuantile(u: number, a: number, c: number, b: number): number {
  const split = (c - a) / (b - a);
  return u < split ? a + Math.sqrt(u * (b - a) * (c - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - c));
}

/** Share of the crowd that has reached the door by `t`. */
export function arrivedShare(e: Pick<VenueEventEstimate, 'arrivalFrom' | 'arrivalPeak' | 'arrivalTo'>, t: number): number {
  return triangularCdf(t, e.arrivalFrom, e.arrivalPeak, e.arrivalTo);
}

const SURGE_PEAK = 6 * MIN;
const SURGE_LENGTH = 35 * MIN;
/** Share of the crowd that has left the door by `t`: early leavers before the end, then the surge. */
export function departedShare(e: Pick<VenueEventEstimate, 'endSec' | 'model'>, t: number): number {
  const { earlyLeave, earlyWindowMin } = e.model;
  const early = earlyLeave * Math.min(1, Math.max(0, (t - (e.endSec - earlyWindowMin * MIN)) / (earlyWindowMin * MIN || 1)));
  return early + (1 - earlyLeave) * triangularCdf(t, e.endSec, e.endSec + SURGE_PEAK, e.endSec + SURGE_LENGTH);
}
/** Departure time at the door for quantile `u` (0-1) of the crowd. */
export function departureQuantile(e: Pick<VenueEventEstimate, 'endSec' | 'model'>, u: number): number {
  const { earlyLeave, earlyWindowMin } = e.model;
  if (u < earlyLeave) return e.endSec - earlyWindowMin * MIN + (u / earlyLeave) * earlyWindowMin * MIN;
  return triangularQuantile((u - earlyLeave) / (1 - earlyLeave), e.endSec, e.endSec + SURGE_PEAK, e.endSec + SURGE_LENGTH);
}

/** Share of the crowd inside the venue at `t`. */
export function insideShare(e: VenueEventEstimate, t: number): number {
  return Math.max(0, arrivedShare(e, t) - departedShare(e, t));
}

function capacityFor(event: CalendarEvent, venue: EventVenue): { capacity: number; setup: string } | null {
  const setup = event.setup && venue.capacities[event.setup] ? event.setup : venue.defaultSetup;
  const capacity = venue.capacities[setup] ?? Object.values(venue.capacities).find((c): c is number => typeof c === 'number' && c > 0) ?? null;
  return capacity ? { capacity, setup } : null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const pct = (v: number) => `${Math.round(v * 100)}%`;

function popularityOf(event: CalendarEvent, popularity: EventPopularityData | null): { entry: EventPopularity | null; reference: number | null; fit: NonNullable<EventPopularityData['calibration'][string]['fit']> | null } {
  const entry = popularity?.events[event.id] ?? null;
  const group = popularity?.calibration[KIND_GROUP[event.kind] ?? 'concert'];
  return { entry, reference: group?.referenceScore ?? null, fit: group?.fit ?? null };
}

/** Expected attendance, split and timings for one calendar event, or null when it can't be estimated (no capacity, campus-only). */
export function estimateEvent(event: CalendarEvent, venue: EventVenue, popularity: EventPopularityData | null): VenueEventEstimate | null {
  const model = KIND_MODELS[event.kind] ?? KIND_MODELS.other;
  if (event.kind === 'campus') return null;
  const cap = capacityFor(event, venue);
  if (!cap) return null;
  const startSec = localSeconds(event.start);
  if (!Number.isFinite(startSec)) return null;
  const provenance: string[] = [`Capacity ${cap.capacity.toLocaleString('en-US')} (${venue.name}, ${cap.setup} setup${venue.capacitySource ? `; ${venue.capacitySource}` : ''}).`];

  const { entry, reference, fit } = popularityOf(event, popularity);
  const score = entry?.source === 'trends' ? entry.score : null;
  const relative = score !== null && reference ? clamp(score / reference, ...RELATIVE_RANGE) : null;
  const top = entry?.termScores?.find((t) => t.term === entry.scoreTerm) ?? entry?.termScores?.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
  const useFitBase = fit !== null && KIND_GROUP[event.kind] === event.kind;
  let fill: number, sd: number, source: PopularityEstimate['source'], note: string;
  if (event.attendance && event.attendance > 0) {
    fill = clamp(event.attendance / cap.capacity, MIN_FILL, 1);
    sd = 0.02;
    source = 'published';
    note = `Published attendance ${event.attendance.toLocaleString('en-US')}`;
    provenance.push(`Attendance as published${event.attendanceSource ? ` (${event.attendanceSource})` : ''}.`);
  } else if (event.soldOut) {
    fill = SOLD_OUT_FILL[1];
    sd = 0;
    source = 'sold-out';
    note = 'Listed as sold out';
    provenance.push(`Listed as sold out: ${pct(SOLD_OUT_FILL[0])}–${pct(SOLD_OUT_FILL[2])} of capacity.`);
  } else {
    const base = useFitBase ? fit!.base : model.fill;
    const elasticity = fit?.elasticity ?? DEFAULT_ELASTICITY;
    fill = relative !== null ? base * relative ** elasticity : model.fill;
    // Spread: the calibration's residuals where its base applies; else the kind's prior spread
    // (a little narrower once a score is known).
    sd = relative === null ? model.fillSd : useFitBase ? Math.max(0.08, fit!.residualSd) : fit ? model.fillSd : model.fillSd * SCORED_SD_SHARE;
    source = relative !== null ? 'trends' : 'prior';
    note = relative !== null
      ? `Trends ${score!.toFixed(2)} (TD Garden = 100), ${relative.toFixed(2)}× a typical ${model.label} event`
      : `No Trends score${entry?.reason ? ` (${entry.reason})` : ''}: ${model.label} prior`;
    provenance.push(relative !== null
      ? `Fill ${pct(base)} × (${score!.toFixed(2)} / ${reference!.toFixed(2)})^${elasticity.toFixed(2)}: ${fit ? `calibrated on ${fit.n} past events with published attendance` : 'uncalibrated prior elasticity'}${useFitBase ? '' : `, ${model.label} prior base`}.`
      : `Fill: ${model.label} prior ${pct(model.fill)} of capacity. ${model.basis}`);
  }
  fill = clamp(fill, MIN_FILL, 1);
  const fillRange: [number, number] = source === 'sold-out'
    ? [SOLD_OUT_FILL[0], SOLD_OUT_FILL[2]]
    : [clamp(fill * Math.exp(-Z80 * sd), 0, 1), clamp(fill * Math.exp(Z80 * sd), 0, 1)];
  const attendees = Math.round(cap.capacity * fill);
  const attendeesRange: [number, number] = [Math.round(cap.capacity * fillRange[0]), Math.round(cap.capacity * fillRange[1])];
  const [shareLow, share, shareHigh] = model.studentShare;
  const students = Math.round(attendees * share);
  const visitors = attendees - students;
  const visitorsRange: [number, number] = [Math.round(attendeesRange[0] * (1 - shareHigh)), Math.round(attendeesRange[1] * (1 - shareLow))];
  provenance.push(`Students ${pct(share)} of attendees (${pct(shareLow)}–${pct(shareHigh)}; assumption by kind), so ${visitors.toLocaleString('en-US')} visitors. Visitors are never counted as students.`);

  const endParsed = event.end ? localSeconds(event.end) + (event.end.slice(0, 10) > event.start.slice(0, 10) ? DAY : 0) : NaN;
  const endEstimated = !Number.isFinite(endParsed) || endParsed <= startSec;
  const endSec = endEstimated ? startSec + model.durationMin * MIN : endParsed;
  let leadMin = model.leadMin;
  if (event.doors) {
    const doors = localSeconds(event.doors);
    if (Number.isFinite(doors) && doors < startSec) leadMin = Math.max(leadMin, (startSec - doors) / MIN + 15);
  }
  const arrivalFrom = startSec - leadMin * MIN;
  const arrivalTo = Math.min(endSec - 10 * MIN, startSec + model.tailMin * MIN);
  const arrivalPeak = clamp(startSec + model.peakMin * MIN, arrivalFrom, arrivalTo);
  provenance.push(`Arrivals from ${leadMin} min before the start, busiest ${model.peakMin >= 0 ? `${model.peakMin} min after` : `${-model.peakMin} min before`} it; ${endEstimated ? `typical ${model.durationMin}-min event` : 'published end'}, then a dismissal surge over ${SURGE_LENGTH / MIN} min.`);

  const area = MODE_SHARES[VENUE_AREA[venue.id] ?? 'west'];
  provenance.push(`Visitors: ${pct(area.transit)} transit, ${pct(area.parking)} drive and park, ${pct(area.rideshare)} rideshare (assumption). ${area.basis}`);

  return {
    event, venue, model, capacity: cap.capacity, capacitySetup: cap.setup,
    popularity: { source, score, relative, reference, calibrated: fit !== null, series: top?.series?.length ? top.series : null, scoreTerm: top?.term ?? null, terms: entry?.terms ?? event.trendsTerms ?? [], window: entry?.window ?? null, note },
    fill, fillRange, attendees, attendeesRange, studentShare: share, students, visitors, visitorsRange,
    startSec, endSec, endEstimated, arrivalFrom, arrivalPeak, arrivalTo,
    departureFrom: endSec - model.earlyWindowMin * MIN, departureTo: endSec + SURGE_LENGTH,
    modes: { transit: area.transit, parking: area.parking, rideshare: area.rideshare }, provenance,
  };
}

export interface EventDay {
  date: string | null;
  events: VenueEventEstimate[];
  /** Calendar events on the date that couldn't be estimated (campus-only, no capacity). */
  skipped: { event: CalendarEvent; reason: string }[];
  routes: EventSources['routes'];
}

export const NO_EVENT_DAY: EventDay = { date: null, events: [], skipped: [], routes: null };

/** Venue events on one Boston date (by their local start date). */
export function planEventDay(sources: EventSources, date: string | null): EventDay {
  if (!date || !sources.calendar) return { ...NO_EVENT_DAY, date, routes: sources.routes };
  const venues = new Map(sources.calendar.venues.map((v) => [v.id, v]));
  const events: VenueEventEstimate[] = [];
  const skipped: EventDay['skipped'] = [];
  for (const event of sources.calendar.events) {
    if (event.start.slice(0, 10) !== date) continue;
    const venue = venues.get(event.venueId);
    const estimate = venue ? estimateEvent(event, venue, sources.popularity) : null;
    if (estimate) events.push(estimate);
    else skipped.push({ event, reason: !venue ? 'venue not mapped' : event.kind === 'campus' ? 'students only: simulated as a campus gathering' : 'no published capacity' });
  }
  events.sort((a, b) => a.startSec - b.startSec || a.event.id.localeCompare(b.event.id));
  return { date, events, skipped, routes: sources.routes };
}

/** Typical walk from arrival point to door at a venue, seconds (for "walking now" estimates). */
function typicalWalkSeconds(day: EventDay, venueId: string): number {
  const origins = day.routes?.venues[venueId]?.origins ?? [];
  if (!origins.length) return 5 * MIN;
  return origins.reduce((sum, o) => sum + o.metres, 0) / origins.length / VISITOR_WALK_SPEED;
}
export const VISITOR_WALK_SPEED = 1.25; // m/s, a crowd on a sidewalk

/**
 * The crowd at a venue at sim time `t` (local seconds on the day's date): who's inside, and the
 * phase. Null when no event there is under way. For other features (event parking, transit load):
 * parking demand is proportional to `visitors` arriving by car (parkingDemandAt).
 */
export function eventLoadAt(day: EventDay, venueId: string, t: number): EventLoad | null {
  let best: EventLoad | null = null;
  for (const e of day.events) {
    if (e.venue.id !== venueId) continue;
    const walk = typicalWalkSeconds(day, venueId);
    if (t < e.arrivalFrom - walk || t > e.departureTo + walk) continue;
    const inside = insideShare(e, t);
    const walking = Math.max(0, arrivedShare(e, t + walk) - arrivedShare(e, t)) + Math.max(0, departedShare(e, t) - departedShare(e, t - walk));
    const phase: EventPhase = t < e.startSec ? 'arriving' : t < e.endSec ? 'in' : 'leaving';
    const load: EventLoad = {
      eventId: e.event.id, name: e.event.name, phase,
      attendees: Math.round(e.attendees * inside), visitors: Math.round(e.visitors * inside), students: Math.round(e.students * inside),
      visitorsWalking: Math.round(e.visitors * walking),
    };
    if (!best || load.attendees + load.visitorsWalking > best.attendees + best.visitorsWalking) best = load;
  }
  return best;
}

// The day the map is showing, so other features (event parking, the public crowd) can ask by venue and time alone.
let currentDay: EventDay = NO_EVENT_DAY;
/** Set by the map whenever the shown day (or its venue events) changes. */
export function setCurrentEventDay(day: EventDay): void {
  currentDay = day;
}
/** eventLoadAt for the day the map is showing. */
export function currentEventLoadAt(venueId: string, time: number): EventLoad | null {
  return eventLoadAt(currentDay, venueId, time);
}
/** parkingDemandAt for the day the map is showing. */
export function currentParkingDemandAt(venueId: string, time: number): ParkingDemand {
  return parkingDemandAt(currentDay, venueId, time);
}

export interface ParkingDemand {
  /** Visitor cars parked for the venue's event now. */
  cars: number;
  /** By garage or lot (VisitorOrigin id), weighted by capacity. */
  byOrigin: Record<string, number>;
  /** Peak cars the event brings (all its car visitors parked at once). */
  peakCars: number;
}

/** Event parking demand at a venue at `t`: car visitors / people per car, between parking and leaving. */
export function parkingDemandAt(day: EventDay, venueId: string, t: number): ParkingDemand {
  const garages = (day.routes?.venues[venueId]?.origins ?? []).filter((o) => o.kind === 'parking');
  const out: ParkingDemand = { cars: 0, byOrigin: {}, peakCars: 0 };
  for (const e of day.events) {
    if (e.venue.id !== venueId) continue;
    const peak = (e.visitors * e.modes.parking) / PEOPLE_PER_CAR;
    const walk = typicalWalkSeconds(day, venueId);
    // Parked from a walk before reaching the door until a walk after leaving it.
    const parked = Math.max(0, arrivedShare(e, t + walk) - departedShare(e, t - walk));
    out.peakCars += Math.round(peak);
    out.cars += Math.round(peak * parked);
    const weights = garageWeights(garages);
    for (const g of garages) out.byOrigin[g.id] = (out.byOrigin[g.id] ?? 0) + Math.round(peak * parked * (weights.get(g.id) ?? 0));
  }
  return out;
}

/** Garage shares by capacity (unknown capacity weighs UNKNOWN_GARAGE_SPACES). */
export function garageWeights(garages: VisitorOrigin[]): Map<string, number> {
  const total = garages.reduce((s, g) => s + (g.capacity ?? UNKNOWN_GARAGE_SPACES), 0);
  return new Map(garages.map((g) => [g.id, total ? (g.capacity ?? UNKNOWN_GARAGE_SPACES) / total : 0]));
}

/** How a venue's visitors split over its arrival points: mode share x (transit by nearness, garages by capacity). */
export function originWeights(e: VenueEventEstimate, origins: VisitorOrigin[]): { origin: VisitorOrigin; weight: number }[] {
  const byKind = { transit: origins.filter((o) => o.kind === 'transit'), parking: origins.filter((o) => o.kind === 'parking'), rideshare: origins.filter((o) => o.kind === 'rideshare') };
  const present = (Object.keys(byKind) as (keyof typeof byKind)[]).filter((k) => byKind[k].length);
  const modeTotal = present.reduce((s, k) => s + e.modes[k], 0) || 1;
  const garages = garageWeights(byKind.parking);
  const out: { origin: VisitorOrigin; weight: number }[] = [];
  for (const kind of present) {
    const share = e.modes[kind] / modeTotal;
    const list = byKind[kind];
    const raw = list.map((o) => (kind === 'parking' ? garages.get(o.id) ?? 0 : kind === 'transit' ? 1 / Math.max(100, o.metres) : 1));
    const sum = raw.reduce((s, w) => s + w, 0) || 1;
    list.forEach((o, i) => out.push({ origin: o, weight: (share * raw[i]) / sum }));
  }
  return out;
}

/** An estimate rounded to what it can claim: tens below a thousand, hundreds above. */
export function roundEstimate(n: number): number {
  return n >= 1000 ? Math.round(n / 100) * 100 : n >= 100 ? Math.round(n / 10) * 10 : Math.round(n);
}
const fmt = (n: number) => roundEstimate(n).toLocaleString('en-US');

/** Tag text for a venue's crowd: "5,900 at event (≈5,300 visitors)", or the walk in or out. */
export function eventLoadLabel(load: EventLoad | null): { text: string; description: string } | undefined {
  if (!load) return undefined;
  if (load.attendees >= 1) {
    const text = `${fmt(load.attendees)} at event (≈${fmt(load.visitors)} visitors)${load.phase === 'leaving' ? ' · leaving' : ''}`;
    return { text, description: `${load.name}: about ${fmt(load.attendees)} people at the event, about ${fmt(load.visitors)} of them visitors (not students)` };
  }
  if (load.visitorsWalking >= 1) {
    const text = `≈${fmt(load.visitorsWalking)} visitors ${load.phase === 'leaving' ? 'leaving' : 'arriving'}`;
    return { text, description: `${load.name}: ${text}` };
  }
  return undefined;
}

/** Which venue a campus location is (Agganis Arena is both), for tags and the panel. */
export function venueForLocation(day: EventDay, locationId: string): string | null {
  return day.events.find((e) => e.venue.locationId === locationId)?.venue.id ?? null;
}
