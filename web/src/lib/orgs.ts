import type { CampusEvent, EventImpactData, FootTraffic, OfficerMeeting, Perk } from '../data/types';

// Student organizations in the browser: officer-posted meetings next to the published listings,
// a turnout preview for a hypothetical event, and tabling spots by foot traffic. Types only.

/** "Dashboard request failed (403): Only verified officers…" → "Only verified officers…". */
export function errorText(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const message = error instanceof Error ? error.message : '';
  return message.replace(/^Dashboard request failed \(\d+\): /, '') || fallback;
}

/** Officer-posted meetings as campus events, so they list, search and RSVP like published ones. Cancelled ones are left out. */
export function officerMeetingEvents(meetings: readonly OfficerMeeting[], clubNames: ReadonlyMap<string, string>): CampusEvent[] {
  return meetings.filter((m) => !m.cancelled).map((m) => ({
    id: m.eventId, title: m.title, locationId: m.locationId, venue: m.room ? `Room ${m.room}` : null, start: m.start, end: m.end,
    organizer: [m.clubId, ...(m.cohosts ?? [])].map((c) => clubNames.get(c)).filter(Boolean).join(' & ') || null,
    clubId: m.clubId, source: 'manual' as const, mapStatus: 'simulated' as const,
    perks: m.perks ?? [], perksNote: m.perksNote ?? '', outdoor: m.outdoor ?? false, seriesId: m.seriesId ?? null,
  }));
}

export const PERK_LABELS: Record<Perk, string> = { food: 'Free food', drinks: 'Drinks', swag: 'Free swag', prizes: 'Prizes', 'free-entry': 'Free entry' };
export const PERK_KEYS = Object.keys(PERK_LABELS) as Perk[];
/** "Free food · Pizza" for a card; empty when nothing is offered. */
export function perkSummary(e: Pick<CampusEvent, 'perks' | 'perksNote'>): string {
  return [...(e.perks ?? []).map((p) => PERK_LABELS[p]), e.perksNote].filter(Boolean).join(' · ');
}

export interface TurnoutHour { hour: number; normal: number; withEvent: number; capacity: number }

/**
 * A hypothetical event's attendees added on top of a place's modeled crowd for the reference
 * weekday, hour by hour by overlap. Not a new simulation: where attendees come from, people who'd
 * have been there anyway and people who stay away aren't modeled.
 */
export function turnoutPreview(impact: Pick<EventImpactData, 'baseline' | 'places'>, placeId: string, weekday: number, startSec: number, durationMin: number, attendees: number): TurnoutHour[] | null {
  const place = impact.places.find((p) => p.id === placeId);
  if (!place || !(place.capacity > 0)) return null;
  const counts = impact.baseline[String(weekday)]?.[placeId] ?? Array(24).fill(0);
  const endSec = startSec + durationMin * 60;
  return counts.map((normal, hour) => {
    const overlap = Math.max(0, Math.min(endSec, (hour + 1) * 3600) - Math.max(startSec, hour * 3600)) / 3600;
    return { hour, normal, withEvent: Math.round(normal + attendees * overlap), capacity: place.capacity };
  });
}

export interface RankedSpot { id: string; name: string; kind: string; locationId?: string; total: number; peakHour: number; hourly: number[] }

/** Spots ranked by simulated people walking in during [fromHour, toHour) on a reference weekday. */
export function rankTablingSpots(foot: FootTraffic, weekday: number, fromHour: number, toHour: number): RankedSpot[] {
  const day = foot.baseline[String(weekday)] ?? {};
  return foot.spots.map((spot) => {
    const hourly = day[spot.id] ?? Array(24).fill(0);
    let total = 0, peakHour = fromHour;
    for (let h = fromHour; h < toHour; h++) {
      total += hourly[h] ?? 0;
      if ((hourly[h] ?? 0) > (hourly[peakHour] ?? 0)) peakHour = h;
    }
    return { id: spot.id, name: spot.name, kind: spot.kind, ...(spot.locationId ? { locationId: spot.locationId } : {}), total, peakHour, hourly };
  }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

/** "9 AM", "12 PM". */
export const hourLabel = (h: number) => `${h % 12 || 12} ${h % 24 < 12 ? 'AM' : 'PM'}`;

export interface ClubDiscovery {
  /** The club's next single meeting (listing or officer post). */
  next: CampusEvent | null;
  /** Shortest walk from home to any of its upcoming meetings, in minutes. */
  walk: number | null;
  /** Its next meeting that doesn't overlap an imported class, if any. */
  freeFit: CampusEvent | null;
}

/**
 * For "meets near me" and "meets when I'm free": each club's upcoming single meetings within the
 * horizon, the shortest walk to one from home, and the first that doesn't overlap a class.
 */
export function discoverClubs(events: readonly CampusEvent[], schedule: readonly { start: string; end: string }[], now: number,
  walkFromHome: (locationId: string) => number | null, horizonDays = 21): Map<string, ClubDiscovery> {
  const horizon = now + horizonDays * 86_400_000;
  const busy = schedule.map((s) => [Date.parse(s.start), Date.parse(s.end)] as const).filter(([a, b]) => Number.isFinite(a) && b > a);
  const out = new Map<string, ClubDiscovery>();
  const upcoming = events.filter((e) => e.clubId && Date.parse(e.start) > now && Date.parse(e.start) < horizon
    && (!e.end || e.end.slice(0, 10) === e.start.slice(0, 10))).sort((a, b) => a.start.localeCompare(b.start));
  for (const e of upcoming) {
    const d = out.get(e.clubId!) ?? { next: null, walk: null, freeFit: null };
    d.next ??= e;
    const w = e.locationId ? walkFromHome(e.locationId) : null;
    if (w !== null && (d.walk === null || w < d.walk)) d.walk = w;
    const s = Date.parse(e.start), end = e.end ? Date.parse(e.end) : s + 2 * 3_600_000;
    if (!d.freeFit && !busy.some(([a, b]) => a < end && b > s)) d.freeFit = e;
    out.set(e.clubId!, d);
  }
  return out;
}
