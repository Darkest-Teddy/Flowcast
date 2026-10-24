import type { CampusEvent } from '../../data/types';

/** The venue as published, or plain words when it isn't public. */
export function eventVenue(event: CampusEvent): string {
  return event.venue ?? 'Location not public';
}

/** Short reason an event does or doesn't change crowding on the map. */
export function mapStatusText(event: CampusEvent): string {
  switch (event.mapStatus) {
    case 'simulated': return 'Changes crowds on the map';
    case 'location-hidden': return 'Not on the map: location is only visible to signed-in students';
    case 'location-unmapped': return 'Not on the map: this building isn’t mapped yet';
    case 'multi-day': return 'Not on the map: multi-day or recurring listing';
    default: return 'Not on the map: no usable time';
  }
}

/** Boston calendar date of an event's start, "2026-11-18". */
export const eventDate = (event: CampusEvent) => event.start.slice(0, 10);
