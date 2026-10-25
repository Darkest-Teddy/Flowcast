// Places off the simulated campus that an area disaster (meteor, earthquake) can be aimed at. They
// are open ground to the incident model (kind 'outdoor', no footprint of their own): the hazard
// radius decides which campus buildings and people nearby are hit.
import type { CampusLocation, DayData } from './playback';

/** Fenway Park, at its venue position in event-calendar.json. The nearest campus building is ~290 m away. */
export const FENWAY_PARK: CampusLocation = {
  id: 'fenway-park', name: 'Fenway Park', short: 'Fenway Park', kind: 'outdoor',
  position: [-71.0970999, 42.3464614], capacity: 0, building: '',
};

export const LANDMARK_TARGETS: readonly CampusLocation[] = [FENWAY_PARK];

/** The day with a landmark target added as a place, so the incident model can aim at it. */
export function withLandmarkTarget(day: DayData, id: string): DayData {
  const landmark = LANDMARK_TARGETS.find((entry) => entry.id === id);
  if (!landmark || day.locations.some((location) => location.id === id)) return day;
  return { ...day, locations: [...day.locations, landmark] };
}
