import type { CampusEvent, EventImpactData, FootTraffic, OfficerMeeting } from '../data/types';

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
    organizer: clubNames.get(m.clubId) ?? null, clubId: m.clubId, source: 'manual' as const, mapStatus: 'simulated' as const,
  }));
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
