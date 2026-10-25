import type { CampusGeo, CampusLocation, ScheduleItem } from '../data/types';
import { bostonDateTime, getDeparturePlan } from './departure';

export function departureAnswer(items: ScheduleItem[], locations: CampusLocation[], geo: CampusGeo, homeLocationId: string | null, now: number) {
  const plan = getDeparturePlan({ items, locations, geo, homeLocationId, now });
  const target = plan.target;
  if (!target) return { text: items.length ? 'No upcoming classes in your imported schedule.' : 'Import your class calendar in Calendars to see when to leave.', rows: [], focus: [] };
  const name = (id: string) => locations.find((place) => place.id === id)?.name ?? '';
  const destination = target.locationText || name(target.locationId) || 'an unmapped location';
  const parts = [`${plan.next ? 'Your next class is' : 'In progress:'} ${target.title} at ${destination}, ${bostonDateTime(target.start)}.`];
  if (plan.leaveBy !== null && plan.walkMinutes !== null && plan.fromLocationId) {
    parts.push(`From ${name(plan.fromLocationId)}, leave by ${bostonDateTime(plan.leaveBy)}: ${plan.walkMinutes} min walking plus ${plan.bufferMinutes} min to arrive early.`);
    if (plan.lateMinutes && plan.next) parts.push(`Leaving now would miss that arrival target by ${plan.lateMinutes} min.`);
  } else if (plan.routeStatus === 'unmapped-destination') {
    parts.push('Match this class to a building in Calendars for a leave-by time.');
  } else if (plan.routeStatus === 'choose-origin') {
    parts.push('Choose your starting building on Home for a leave-by time.');
  } else {
    parts.push('No saved walking route is available for these buildings.');
  }
  if (plan.overlap) parts.push('This class overlaps the previous class.');
  else if (plan.connectionShortfallMinutes && plan.previous) parts.push(`The gap after ${plan.previous.title} is ${plan.connectionShortfallMinutes} min shorter than the walk and arrival buffer.`);
  const focus = [plan.fromLocationId, target.locationId].filter((id): id is string => !!id && !!name(id));
  return { text: parts.join(' '), rows: [], focus };
}
