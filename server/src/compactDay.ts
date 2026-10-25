// A simulated day as the server reads it. Each built Playback keeps every walk's path and timestamps
// (~250 MB a day; seven cached days took ~1.8 GB), but the Ask tools only read head counts per place,
// population totals and where walkers are heading. CompactDay keeps just those: the same occupancy
// index the Playback builds from the day's stays, and each walk's start, end and destination
// (a few MB a day). Answers are identical to the Playback's at every time.

import { Playback, type CampusLocation, type Occupancy } from '../../map-client/src/sim/playback';
import { createOccupancyIndex, occupancyIndexFrom, type OccupancyEvents, type OccupancyIndex } from '../../map-client/src/sim/occupancyIndex';
import { splitResidenceStays } from '../../map-client/src/sim/residenceSplit';

/** What the server reads from a built day. Playback satisfies it too. */
export interface DayView {
  readonly locations: CampusLocation[];
  occupancyAt(t: number): Occupancy[];
  populationAt(t: number): ReturnType<Playback['populationAt']>;
  walkingAt(t: number): { to: string }[];
}

/** Long enough that trailsAt covers every five-minute bucket of the day, including walks past midnight. */
const WHOLE_DAY = 3 * 86400;

/** Everything a CompactDay answers from. Plain data, so a day built on a worker thread can be sent back. */
export interface CompactDayData {
  locations: CampusLocation[];
  total: number;
  // Walks sorted by start; `to` is an index into `destinations`.
  starts: Float64Array;
  ends: Float64Array;
  to: Uint16Array;
  destinations: string[];
  occupancy: OccupancyEvents;
}

export class CompactDay implements DayView {
  readonly locations: CampusLocation[];
  private readonly onMap: CampusLocation[];
  private readonly total: number;
  private readonly starts: Float64Array;
  private readonly ends: Float64Array;
  private readonly to: Uint16Array;
  private readonly destinations: string[];
  private readonly index: OccupancyIndex;

  constructor(readonly data: CompactDayData) {
    this.locations = data.locations;
    this.total = data.total;
    this.starts = data.starts;
    this.ends = data.ends;
    this.to = data.to;
    this.destinations = data.destinations;
    this.onMap = data.locations.filter((location) => location.kind !== 'off-campus');
    this.index = occupancyIndexFrom(data.occupancy);
  }

  static fromPlayback(playback: Playback, index: OccupancyIndex): CompactDay {
    // trailsAt returns the walks exactly as walkingAt reads them (doorway legs and casualty cuts applied).
    const walks = [...playback.trailsAt(2 * 86400, WHOLE_DAY)]
      .map((trip) => ({ start: trip.timestamps[0], end: trip.timestamps[trip.timestamps.length - 1], to: trip.to }))
      .sort((a, b) => a.start - b.start);
    const ids = new Map<string, number>();
    for (const walk of walks) if (!ids.has(walk.to)) ids.set(walk.to, ids.size);
    if (ids.size > 0xffff) throw new Error('Too many walk destinations for CompactDay');
    const starts = new Float64Array(walks.length);
    const ends = new Float64Array(walks.length);
    const to = new Uint16Array(walks.length);
    walks.forEach((walk, i) => { starts[i] = walk.start; ends[i] = walk.end; to[i] = ids.get(walk.to)!; });
    return new CompactDay({
      locations: playback.locations, total: playback.data.agents.length, starts, ends, to, destinations: [...ids.keys()], occupancy: index.events,
    });
  }

  /** Same as Playback.occupancyAt for a day with stays, a valid index and no casualties. */
  occupancyAt(t: number): Occupancy[] {
    const counts = this.index.countsAt(t);
    return this.onMap.map((location) => {
      const count = counts.get(location.id) ?? 0;
      return { location, count, share: location.capacity > 0 ? count / location.capacity : 0, modeled: location.activityModeled !== false };
    });
  }

  walkingAt(t: number): { to: string }[] {
    const out: { to: string }[] = [];
    for (let i = 0; i < this.starts.length && this.starts[i] <= t; i++) {
      if (t < this.ends[i]) out.push({ to: this.destinations[this.to[i]] });
    }
    return out;
  }

  populationAt(t: number): ReturnType<Playback['populationAt']> {
    let indoors = 0, outdoors = 0;
    for (const entry of this.occupancyAt(t)) {
      if (entry.location.kind === 'outdoor') outdoors += entry.count; else indoors += entry.count;
    }
    const walking = this.walkingAt(t).length;
    const total = this.total;
    return { total, indoors, outdoors, walking, offCampus: total - indoors - outdoors - walking, injured: 0, fatalities: 0, alive: total };
  }
}

/**
 * The compact form of a built day, or the Playback itself when its answers depend on more than
 * CompactDay keeps: casualties, no stays, or stays the occupancy index can't summarize.
 */
export function compactDay(playback: Playback): DayView {
  if (!playback.data.stays || playback.casualtiesAt(Number.MAX_VALUE).length > 0) return playback;
  // Counted as Playback counts them: a residence with classrooms is two places (sim/residenceSplit.ts).
  const index = createOccupancyIndex(splitResidenceStays(playback.data.stays, playback.data.locations));
  return index ? CompactDay.fromPlayback(playback, index) : playback;
}
