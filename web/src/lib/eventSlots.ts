// "Plan an event": the request a club officer fills in and the server's answer (GET
// /api/dashboard/event-slots, server/src/eventSlots.ts). Seats, classes and venue events are
// published; nearby crowding is model-derived; parking is stated spaces, not availability. A free
// room may still be in use or locked, and nothing is ever booked.

export interface EventPlan {
  headcount: number;
  /** Reference-week weekdays, 0 = Monday; empty for the whole week. */
  days: number[];
  /** HH:MM, 24-hour. */
  from: string;
  to: string;
  durationMin: number;
  campus: 'charles-river' | 'medical' | 'fenway';
}

export interface EventSlot {
  date: string;
  weekday: number;
  start: string;
  end: string;
  building: string;
  room: string;
  seats: number;
  campus: string;
  nearbyCrowd: { percent: number; place: string } | null;
  parking: { spaces: number; lots: number; nearest: { name: string; metres: number } | null };
  venueEventsSameDay: string[];
}

export interface EventSlotsResult {
  headcount: number;
  days: { date: string; weekday: number }[];
  window: { from: string; to: string };
  durationMin: number;
  slots: EventSlot[];
  counts: { rooms: number; roomsWithSeats: number; checked: number; withClass: number; withListedEvent: number; nearVenueEvent: number; free: number };
  venueConflicts: { name: string; venue: string; date: string; start: string }[];
  largestRoom: { building: string; room: string; seats: number } | null;
  caveat: string;
  method: string;
}

export const DEFAULT_PLAN: EventPlan = { headcount: 30, days: [], from: '18:00', to: '22:00', durationMin: 90, campus: 'charles-river' };

const minutes = (hhmm: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  return m && Number(m[1]) <= 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** What's wrong with a plan, in words for the form, or null when it can be sent. */
export function planProblem(plan: EventPlan): string | null {
  if (!Number.isInteger(plan.headcount) || plan.headcount < 1) return 'Enter how many people you expect.';
  if (plan.headcount > 2000) return 'Plans are limited to 2,000 people.';
  const from = minutes(plan.from), to = minutes(plan.to);
  if (from === null || to === null) return 'Choose a start and end time.';
  if (to - from < plan.durationMin) return 'The event doesn’t fit between those times.';
  return null;
}

/** The query string for GET /api/dashboard/event-slots. */
export function eventSlotsQuery(plan: EventPlan, limit = 10): string {
  const q = new URLSearchParams({ headcount: String(plan.headcount), from: plan.from, to: plan.to, duration: String(plan.durationMin), campus: plan.campus, limit: String(limit) });
  const days = [...new Set(plan.days)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort((a, b) => a - b);
  if (days.length && days.length < 7) q.set('days', days.join(','));
  return q.toString();
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The server's answer, checked; throws when it isn't one, so the page shows an error instead of guessing. */
export function parseEventSlots(body: unknown): EventSlotsResult {
  if (!isObject(body) || !Array.isArray(body.slots) || !isObject(body.counts) || typeof body.caveat !== 'string') {
    throw new Error('The event planner sent an answer this page can’t read.');
  }
  const slots = body.slots.filter((s): s is EventSlot => isObject(s) && typeof s.date === 'string' && typeof s.room === 'string'
    && typeof s.building === 'string' && typeof s.seats === 'number' && typeof s.start === 'string' && isObject(s.parking));
  return { ...(body as unknown as EventSlotsResult), slots, venueConflicts: Array.isArray(body.venueConflicts) ? body.venueConflicts as EventSlotsResult['venueConflicts'] : [] };
}

/** "Room 220, Questrom School of Business". */
export const slotRoom = (s: EventSlot) => `Room ${s.room}, ${s.building}`;
