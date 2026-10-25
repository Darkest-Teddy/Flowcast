// Parking: an estimate of how full the garages and lots around BU and its event venues are at the
// shown day and time. It is a separate estimate layer: it never changes a student's timeline, a
// building's occupancy or any count (students in the roster don't drive in this model).
//
// Each lot's fullness is
//  1. a baseline by the kind of lot (BU commuter garages fill 7-9 am, hold, drain 4-7 pm; medical
//     garages run 24/7 with a 7 am shift change; public garages follow shops and restaurants),
//     lower on weekends and on BU holidays and breaks, shifted a few minutes per lot so lots
//     don't move in lockstep, plus
//  2. event parking: each event brings an estimated number of cars that arrive over the 2 h before
//     the start, stay through the end and leave over the hour after. The cars go to the lot
//     nearest the venue that takes event parking until it is full, then spill to the next nearest,
//     out to the venue's walking radius; anything left over is counted as not finding a lot.
// Deterministic and cheap (a few dozen lots and events): App recomputes it at most twice a second.

export type LotKind = 'garage' | 'surface' | 'underground';
export type LotProfile = 'bu-commuter' | 'bu-mixed' | 'medical' | 'public';
export type CapacityBasis = 'osm' | 'published' | 'estimate';

export interface ParkingLot {
  id: string;
  name: string;
  /** Tag name: "Agganis Garage". */
  short: string;
  kind: LotKind;
  operator: string;
  /** Run by BU (Parking & Transportation Services). */
  bu: boolean;
  campus: string;
  /** Tag anchor, [lng, lat]. */
  position: [number, number];
  /** Outer ring, [lng, lat]. */
  polygon: [number, number][];
  /** Roof of a garage structure, metres (0 for surface lots and garages under another building). */
  height: number;
  /** True when the garage is below or inside a building that isn't a garage (Agganis, Warren). */
  underBuilding: boolean;
  capacity: number;
  capacityBasis: CapacityBasis;
  capacityNote: string;
  profile: LotProfile;
  /** Sells event parking (Red Sox, concerts, BU games). */
  eventParking: boolean;
  osm: string | null;
  sourceUrl: string;
}

export interface ParkingVenue {
  id: string;
  name: string;
  position: [number, number];
  /** How far event drivers will walk from a lot, metres. */
  walkRadius: number;
}

export interface ParkingEvent {
  id: string;
  venue: string;
  name: string;
  /** YYYY-MM-DD, Boston. */
  date: string;
  /** Seconds after midnight. */
  start: number;
  end: number;
  /** Estimated cars parked off-street for the event. */
  cars: number;
  /** True for a placeholder (no published schedule for that date). */
  sample: boolean;
  source: string;
  sourceUrl: string;
}

export interface ParkingData {
  schemaVersion: 1;
  generatedAt: string;
  lots: ParkingLot[];
  venues: ParkingVenue[];
  events: ParkingEvent[];
  notes: string[];
  sources: { label: string; url: string }[];
}

export type DayKind = 'weekday' | 'weekend' | 'holiday' | 'break';

export interface ParkingDay {
  date: string;
  /** 0 = Monday (the app's day picker). */
  weekday: number;
  kind: DayKind;
}

export type Trend = 'filling' | 'emptying' | 'steady';

export interface LotState {
  lot: ParkingLot;
  cars: number;
  /** cars / capacity, 0..1. */
  share: number;
  free: number;
  full: boolean;
  /** Cars here for an event now. */
  eventCars: number;
  /** The event bringing the most cars here now. */
  event: ParkingEvent | null;
  trend: Trend;
}

export interface EventState {
  event: ParkingEvent;
  venue: ParkingVenue | null;
  /** 0..1 of the event's cars parked now. */
  ramp: number;
  /** Cars parked for it now, and those that found no lot within the walking radius. */
  parked: number;
  unparked: number;
  /** When parking starts filling (2 h before) and is clear again (1 h after the end), seconds. */
  arriveFrom: number;
  clearBy: number;
}

export interface ParkingState {
  time: number;
  day: ParkingDay;
  lots: LotState[];
  /** The day's events, by start time (including ones already over or not yet started). */
  events: EventState[];
  /** A short string that changes whenever any lot's colour level or FULL state does. */
  levelKey: string;
  totals: { cars: number; capacity: number; full: number };
}

export const ARRIVE_BEFORE = 2 * 3600;
export const LEAVE_AFTER = 3600;
/** A lot counts as FULL with this share taken (a garage is effectively full before the last space). */
export const FULL_SHARE = 0.97;
/** Trend window: compared with the estimate this far ahead. */
const TREND_AHEAD = 15 * 60;
const TREND_MIN = 0.02;

// Share of capacity taken at each hour 0..24 (linear in between), by profile and kind of day.
// Rough shapes from typical urban-campus parking utilisation: estimates, not counts.
const CURVES: Record<LotProfile, { weekday: number[]; weekend: number[] }> = {
  'bu-commuter': {
    weekday: [0.1, 0.09, 0.08, 0.08, 0.08, 0.1, 0.17, 0.38, 0.68, 0.85, 0.9, 0.91, 0.9, 0.9, 0.89, 0.86, 0.76, 0.55, 0.36, 0.25, 0.19, 0.15, 0.12, 0.11, 0.1],
    weekend: [0.08, 0.08, 0.07, 0.07, 0.07, 0.07, 0.08, 0.09, 0.11, 0.14, 0.18, 0.21, 0.23, 0.23, 0.22, 0.2, 0.18, 0.16, 0.14, 0.12, 0.11, 0.1, 0.09, 0.08, 0.08],
  },
  // BU garages that also hold resident and overnight permits (Warren, StuVi area).
  'bu-mixed': {
    weekday: [0.36, 0.36, 0.35, 0.35, 0.35, 0.36, 0.4, 0.52, 0.72, 0.84, 0.88, 0.89, 0.88, 0.88, 0.87, 0.84, 0.76, 0.62, 0.5, 0.44, 0.41, 0.39, 0.38, 0.37, 0.36],
    weekend: [0.34, 0.34, 0.33, 0.33, 0.33, 0.33, 0.33, 0.34, 0.36, 0.38, 0.41, 0.43, 0.44, 0.44, 0.43, 0.42, 0.41, 0.4, 0.38, 0.37, 0.36, 0.35, 0.35, 0.34, 0.34],
  },
  // Hospital and medical-campus garages: staff around the clock, shift change at 7 am, clinic visitors by day.
  medical: {
    weekday: [0.32, 0.31, 0.3, 0.3, 0.3, 0.34, 0.48, 0.72, 0.86, 0.92, 0.94, 0.94, 0.93, 0.93, 0.92, 0.88, 0.8, 0.66, 0.54, 0.46, 0.42, 0.38, 0.35, 0.33, 0.32],
    weekend: [0.28, 0.27, 0.27, 0.27, 0.27, 0.29, 0.36, 0.46, 0.53, 0.58, 0.6, 0.6, 0.6, 0.59, 0.58, 0.56, 0.52, 0.46, 0.4, 0.36, 0.33, 0.31, 0.3, 0.29, 0.28],
  },
  // Public garages and lots (Kenmore, Fenway): offices, shops, restaurants, hotels.
  public: {
    weekday: [0.14, 0.12, 0.11, 0.1, 0.1, 0.11, 0.15, 0.25, 0.4, 0.52, 0.58, 0.62, 0.64, 0.62, 0.6, 0.57, 0.53, 0.49, 0.47, 0.45, 0.42, 0.36, 0.28, 0.2, 0.14],
    weekend: [0.16, 0.13, 0.11, 0.1, 0.1, 0.1, 0.11, 0.14, 0.2, 0.28, 0.37, 0.45, 0.5, 0.52, 0.52, 0.5, 0.48, 0.47, 0.47, 0.46, 0.43, 0.37, 0.3, 0.22, 0.16],
  },
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (v: number) => {
  const x = clamp01(v);
  return x * x * (3 - 2 * x);
};

/** A stable number in [0, 1) from a string (FNV-1a). */
function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 2 ** 32;
}

function curveAt(values: number[], time: number): number {
  const h = (((time / 3600) % 24) + 24) % 24;
  const i = Math.floor(h);
  return values[i] + (values[i + 1] - values[i]) * (h - i);
}

/** Baseline share of a lot taken at `time` (seconds after midnight) on this kind of day, no events. */
export function baselineShare(lot: Pick<ParkingLot, 'id' | 'profile'>, kind: DayKind, time: number): number {
  const curves = CURVES[lot.profile];
  // Each lot runs up to ±20 min early or late and ±6% fuller or emptier.
  const jitter = hash01(lot.id);
  const shifted = time - (jitter - 0.5) * 2400;
  const scale = 0.94 + 0.12 * hash01(`${lot.id}:scale`);
  const weekday = curveAt(curves.weekday, shifted);
  const weekend = curveAt(curves.weekend, shifted);
  const bu = lot.profile === 'bu-commuter' || lot.profile === 'bu-mixed';
  let share: number;
  if (kind === 'weekend') share = weekend;
  // BU holidays and breaks only empty BU's own lots; hospitals and the city keep working.
  else if (kind === 'holiday') share = bu ? 0.3 * weekday + 0.7 * weekend : lot.profile === 'public' ? 0.5 * weekday + 0.5 * weekend : weekday;
  else if (kind === 'break') share = bu ? 0.7 * weekday + 0.3 * weekend : weekday;
  else share = weekday;
  return clamp01(share * scale);
}

/** Share (0..1) of an event's cars parked at `time`: ramps up over 2 h to the start, holds, drains over 1 h after the end. */
export function eventRamp(event: Pick<ParkingEvent, 'start' | 'end'>, time: number): number {
  const end = event.end > event.start ? event.end : event.end + 86400;
  if (time <= event.start - ARRIVE_BEFORE || time >= end + LEAVE_AFTER) return 0;
  if (time < event.start) return smooth((time - (event.start - ARRIVE_BEFORE)) / ARRIVE_BEFORE);
  if (time <= end) return 1;
  return 1 - smooth((time - end) / LEAVE_AFTER);
}

/** Weekend, BU holiday or break from the academic calendar (Fall/Spring terms), else a weekday. */
export function parkingDayKind(
  date: string,
  weekday: number,
  terms?: { classesStart: string; classesEnd: string; suspendedDates: string[]; events?: { kind: string; end: string }[] }[],
): DayKind {
  if (weekday >= 5) return 'weekend';
  if (!terms?.length) return 'weekday';
  if (terms.some((t) => t.suspendedDates.includes(date))) return 'holiday';
  // In term from the first day of classes to the end of exams.
  const inTerm = terms.some((t) => {
    const examsEnd = t.events?.filter((e) => e.kind === 'exams').map((e) => e.end).sort().at(-1) ?? t.classesEnd;
    return date >= t.classesStart && date <= examsEnd;
  });
  return inTerm ? 'weekday' : 'break';
}

const M_PER_DEG_LAT = 110_540;
function metres(a: [number, number], b: [number, number]): number {
  const kx = 111_320 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * M_PER_DEG_LAT);
}

/** Lots and venues indexed for the per-refresh estimate. Build once per data load. */
export interface ParkingModel {
  data: ParkingData;
  venues: Map<string, ParkingVenue>;
  /** Per venue: indexes into data.lots that take event parking within its walking radius, nearest first. */
  spill: Map<string, number[]>;
}

export function createParkingModel(data: ParkingData): ParkingModel {
  const venues = new Map(data.venues.map((v) => [v.id, v]));
  const spill = new Map<string, number[]>();
  for (const venue of data.venues) {
    const near = data.lots
      .map((lot, index) => ({ index, distance: metres(lot.position, venue.position) }))
      .filter((l) => data.lots[l.index].eventParking && l.distance <= venue.walkRadius)
      .sort((a, b) => a.distance - b.distance);
    spill.set(venue.id, near.map((l) => l.index));
  }
  return { data, venues, spill };
}

/** The events on `date` (the data's own plus any extra ones, e.g. campus events), by start time. */
export function eventsOn(model: ParkingModel, date: string, extra: readonly ParkingEvent[] = []): ParkingEvent[] {
  return [...model.data.events, ...extra].filter((e) => e.date === date && model.venues.has(e.venue)).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

interface Fill {
  cars: Float64Array;
  eventCars: Float64Array;
  topEvent: (ParkingEvent | null)[];
  topCars: Float64Array;
  parked: Map<string, number>;
}

function fillAt(model: ParkingModel, day: ParkingDay, events: ParkingEvent[], time: number): Fill {
  const lots = model.data.lots;
  const cars = new Float64Array(lots.length);
  for (let i = 0; i < lots.length; i++) cars[i] = baselineShare(lots[i], day.kind, time) * lots[i].capacity;
  const eventCars = new Float64Array(lots.length);
  const topCars = new Float64Array(lots.length);
  const topEvent: (ParkingEvent | null)[] = lots.map(() => null);
  const parked = new Map<string, number>();
  // Earlier events claim spaces first (their cars arrived first).
  for (const event of events) {
    let remaining = event.cars * eventRamp(event, time);
    if (remaining <= 0) continue;
    let placed = 0;
    for (const i of model.spill.get(event.venue) ?? []) {
      const free = lots[i].capacity - cars[i];
      if (free <= 0) continue;
      const take = Math.min(free, remaining);
      cars[i] += take;
      eventCars[i] += take;
      placed += take;
      if (take > topCars[i]) {
        topCars[i] = take;
        topEvent[i] = event;
      }
      remaining -= take;
      if (remaining <= 0) break;
    }
    parked.set(event.id, placed);
  }
  return { cars, eventCars, topEvent, topCars, parked };
}

/** Every lot's estimated cars, share, FULL state and trend, and the day's events, at `time`. */
export function parkingAt(model: ParkingModel, day: ParkingDay, time: number, extraEvents: readonly ParkingEvent[] = []): ParkingState {
  const events = eventsOn(model, day.date, extraEvents);
  const now = fillAt(model, day, events, time);
  const ahead = fillAt(model, day, events, time + TREND_AHEAD);
  let levelKey = '';
  let totalCars = 0;
  let totalCapacity = 0;
  let fullCount = 0;
  const lots = model.data.lots.map((lot, i): LotState => {
    const cars = Math.round(now.cars[i]);
    const share = lot.capacity > 0 ? clamp01(now.cars[i] / lot.capacity) : 0;
    const full = share >= FULL_SHARE;
    const delta = (ahead.cars[i] - now.cars[i]) / Math.max(1, lot.capacity);
    const trend: Trend = delta >= TREND_MIN ? 'filling' : delta <= -TREND_MIN ? 'emptying' : 'steady';
    levelKey += `${levelIndex(share)}${full ? 'F' : ''}`;
    totalCars += cars;
    totalCapacity += lot.capacity;
    if (full) fullCount++;
    return { lot, cars, share, free: Math.max(0, lot.capacity - cars), full, eventCars: Math.round(now.eventCars[i]), event: now.topEvent[i], trend };
  });
  const eventStates = events.map((event): EventState => {
    const ramp = eventRamp(event, time);
    const parked = Math.round(now.parked.get(event.id) ?? 0);
    const end = event.end > event.start ? event.end : event.end + 86400;
    return {
      event,
      venue: model.venues.get(event.venue) ?? null,
      ramp,
      parked,
      unparked: Math.max(0, Math.round(event.cars * ramp) - parked),
      arriveFrom: event.start - ARRIVE_BEFORE,
      clearBy: end + LEAVE_AFTER,
    };
  });
  return { time, day, lots, events: eventStates, levelKey, totals: { cars: totalCars, capacity: totalCapacity, full: fullCount } };
}

/**
 * A lot's bucket (0-3 at 0.3, 0.6 and 0.85), used only to build `levelKey`, the redraw trigger for
 * the parking layers: its own steps, not the crowd scale's (theme/crowd.ts), so a change here
 * costs a repaint and nothing more.
 */
export function levelIndex(share: number): 0 | 1 | 2 | 3 {
  return share >= 0.85 ? 3 : share >= 0.6 ? 2 : share >= 0.3 ? 1 : 0;
}

/** "HH:MM" or "H:MM" to seconds after midnight. */
export function clockSeconds(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 3600 + (m || 0) * 60;
}

export async function loadParking(url = '/data/parking.json'): Promise<ParkingData> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Parking data unavailable (${response.status})`);
  const data = (await response.json()) as ParkingData;
  if (data.schemaVersion !== 1 || !Array.isArray(data.lots)) throw new Error('Parking data has an unsupported format');
  return data;
}

/**
 * BU's own events from the campus snapshot (campus-data.json), as small parking demands at the
 * Charles River campus: published registration counts are tiny, so each brings a handful of cars
 * at most. Multi-day listings (weekly meetings across a term) are skipped.
 */
export function campusParkingEvents(
  events: readonly { id: string; name: string; start: string; end: string | null; registrationCount: number | null; sourceUrl: string }[],
  venue = 'bu-campus',
): ParkingEvent[] {
  const out: ParkingEvent[] = [];
  for (const e of events) {
    const date = e.start.slice(0, 10);
    const start = clockSeconds(e.start.slice(11, 16));
    const endDate = e.end?.slice(0, 10) ?? date;
    if (endDate !== date) continue;
    const end = e.end ? clockSeconds(e.end.slice(11, 16)) : start + 2 * 3600;
    // Assumed 40 attendees when unpublished; ~1 in 8 drives (most are students on foot).
    const cars = Math.round(Math.max(e.registrationCount ?? 0, 40) / 8);
    out.push({ id: `campus:${e.id}`, venue, name: e.name, date, start, end, cars, sample: false, source: 'BU events (campus-data.json); cars estimated', sourceUrl: e.sourceUrl });
  }
  return out;
}
