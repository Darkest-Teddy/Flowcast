// A residence that also holds classrooms (Kilachand) is two places to a student: the dorm, where
// its residents live, and the classrooms and study rooms that everyone else comes to. Counted as one,
// their numbers mix: residents leaving for the day hide a busy afternoon of classes, and a full
// classroom pushes the dorm over its beds. So wherever people are counted (the map's playback, the
// dashboard's hourly build), each such residence is reported as two places. The simulated day itself
// is untouched: its trips, stays and capacity ledger still see one building.
//
//   the residence (same id): people at home there, out of its beds
//   "<id>-classrooms": everyone there for anything else (class, study, an event, waiting between
//   classes), out of its classroom seats
//
// Both share the building footprint and entrance, so the map draws one building and routes to one door.
import type { CampusLocation, Stay } from './playback';

export const CLASSROOM_SUFFIX = '-classrooms';

/** A residence with classrooms whose beds and seats are both known, so each half has a denominator. */
export function splitsResidence(location: CampusLocation): boolean {
  const beds = location.residentialBeds ?? 0;
  return location.kind === 'dorm' && location.capacityBasis === 'residential_beds_plus_classroom_seats'
    && beds > 0 && location.capacity > beds;
}

/** Each split residence becomes the residence (its beds) followed by its classrooms (its seats); the rest pass through. */
export function splitResidences<L extends CampusLocation>(locations: readonly L[]): L[] {
  return locations.flatMap((location) => {
    if (!splitsResidence(location)) return [location];
    const beds = location.residentialBeds!;
    const seats = location.capacity - beds;
    const residence = { ...location, capacity: beds, referenceCapacity: beds, capacityBasis: 'residential_beds' };
    const classrooms = {
      ...location,
      id: `${location.id}${CLASSROOM_SUFFIX}`,
      name: `${location.name} classrooms & study`,
      short: `${location.short} classrooms`,
      kind: 'classroom' as const,
      capacity: seats,
      referenceCapacity: seats,
      capacityBasis: 'deduplicated_classroom_seats',
      residentialBeds: undefined,
      estimatedHousingProfile: undefined,
    };
    return [residence, classrooms];
  });
}

/** Where a stay is counted: at a split residence, anyone not at home is in its classrooms. */
export function countedLocation(stay: Pick<Stay, 'location' | 'purpose'>, split: ReadonlySet<string>): string {
  return split.has(stay.location) && stay.purpose?.kind !== 'home' ? `${stay.location}${CLASSROOM_SUFFIX}` : stay.location;
}

/** The ids of the residences that split. */
export const splitResidenceIds = (locations: readonly CampusLocation[]): Set<string> =>
  new Set(locations.filter(splitsResidence).map((location) => location.id));

/** The stays as they are counted (see countedLocation); the same objects when nothing splits. */
export function splitResidenceStays<S extends Pick<Stay, 'location' | 'purpose'>>(stays: readonly S[], locations: readonly CampusLocation[]): S[] {
  const split = splitResidenceIds(locations);
  if (!split.size) return stays as S[];
  return stays.map((stay) => {
    const location = countedLocation(stay, split);
    return location === stay.location ? stay : { ...stay, location };
  });
}
