import type { CampusGeo, CampusLocation, ScheduleItem } from '../data/types';
import { bostonDateTime, bostonTime, getDeparturePlan } from './departure';
import { departureBasisLabel, exclusionLabel, type TransitContext, type TransitOption } from './transitDeparture';

/** One leave-by row per way there, for "when should I leave". */
export interface LeaveByRow { id: 'walk' | 'transit'; title: string; detail: string }

const transitSentence = (option: TransitOption, walking: boolean) =>
  `${walking ? 'Or by' : 'By'} ${option.routeName}: leave by ${bostonDateTime(option.leaveBy)}, walk ${option.walkToStopMinutes} min to ${option.boardStop.name}, `
  + `take the ${bostonTime(option.departure)} departure${option.toward ? ` ${option.toward}` : ''} to ${option.alightStop.name}, then walk ${option.walkFromStopMinutes} min, `
  + `arriving ${bostonTime(option.atClass)}, ${option.marginMinutes} min before class (${departureBasisLabel(option)}).`;

export function departureAnswer(items: ScheduleItem[], locations: CampusLocation[], geo: CampusGeo, homeLocationId: string | null, now: number, transit?: TransitContext) {
  const plan = getDeparturePlan({ items, locations, geo, homeLocationId, now, transit });
  const target = plan.target;
  if (!target) return { text: items.length ? 'No upcoming classes in your imported schedule.' : 'Import your class calendar in Calendars to see when to leave.', rows: [], focus: [] };
  const name = (id: string) => locations.find((place) => place.id === id)?.name ?? '';
  const destination = target.locationText || name(target.locationId) || 'an unmapped location';
  const parts = [`${plan.next ? 'Your next class is' : 'In progress:'} ${target.title} at ${destination}, ${bostonDateTime(target.start)}.`];
  const rows: LeaveByRow[] = [];
  const option = plan.transit?.status === 'offered' ? plan.transit.option : null;
  if (plan.leaveBy !== null && plan.walkMinutes !== null && plan.fromLocationId) {
    parts.push(`From ${name(plan.fromLocationId)}, leave by ${bostonDateTime(plan.leaveBy)}: ${plan.walkMinutes} min walking plus ${plan.bufferMinutes} min to arrive early.`);
    if (plan.lateMinutes && plan.next) parts.push(`Leaving now would miss that arrival target by ${plan.lateMinutes} min.`);
    rows.push({ id: 'walk', title: `Walk · leave by ${bostonTime(plan.leaveBy)}`, detail: `${plan.walkMinutes} min walk · ${plan.bufferMinutes} min buffer` });
  } else if (plan.routeStatus === 'unmapped-destination') {
    parts.push('Match this class to a building in Calendars for a leave-by time.');
  } else if (plan.routeStatus === 'choose-origin') {
    parts.push('Choose your starting building on Home for a leave-by time.');
  } else if (!option) {
    parts.push(plan.fromLocationId ? `No saved walking route or published trip gets you from ${name(plan.fromLocationId)} to this class.` : 'No saved walking route is available for these buildings.');
  }
  if (option) {
    parts.push(transitSentence(option, plan.leaveBy !== null));
    rows.push({ id: 'transit', title: `${option.routeName} · leave by ${bostonTime(option.leaveBy)}`,
      detail: `${option.boardStop.name} ${bostonTime(option.departure)} → ${option.alightStop.name} · arrive ${bostonTime(option.atClass)} · ${option.departureBasis === 'live' ? 'live' : 'timetable'}` });
  }
  if (plan.transit && (option || plan.leaveBy === null)) parts.push(...plan.transit.excluded.map(exclusionLabel));
  if (plan.overlap) parts.push('This class overlaps the previous class.');
  else if (plan.connectionShortfallMinutes && plan.previous) parts.push(`The gap after ${plan.previous.title} is ${plan.connectionShortfallMinutes} min shorter than the walk and arrival buffer.`);
  const focus = [plan.fromLocationId, target.locationId].filter((id): id is string => !!id && !!name(id));
  // Rows only when there is a choice between ways there; a single walk stays one sentence.
  return { text: parts.join(' '), rows: rows.length > 1 ? rows : [], focus };
}
