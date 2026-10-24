// Scores a simulated day against BU's measured series and plain sanity targets. Used headlessly
// by scripts/validate-behavior.mjs and scripts/calibrate-behavior.mjs (never in the browser).
// Every metric has a loss ≥ 0 (lower is better), so a proposal can be checked metric by metric.
import type { CampusData } from '../data/campusData';
import type { DayData } from './playback';
import type { SourceDay } from './sourceDay';

export interface Metric {
  id: string;
  label: string;
  value: number;
  /** ≥ 0, lower is better; 0 means on target. */
  loss: number;
  target: string;
  source?: string;
  weight: number;
}
export interface DayScore { day: string; metrics: Metric[]; loss: number }

export interface BikeProfileStation { campus?: string; profile?: { arrivals: number[]; departures: number[] } }
export interface BikesData { weekday: string; binSeconds: number; stations: BikeProfileStation[] }

const DAY = 86400;
const MAIN_HALLS = ['warren-dining', 'west-dining', 'marciano'];
const MEALS = { breakfast: [0, 10.5], lunch: [10.5, 15.5], dinner: [15.5, 24] } as const;

export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}
const argmax = (values: number[]) => values.reduce((best, value, index) => value > values[best] ? index : best, 0);
/** |log(ratio)| with a floor, so 2× too many and 2× too few cost the same. */
const ratioLoss = (ratio: number) => Math.abs(Math.log(Math.max(1e-3, ratio)));
const hinge = (value: number, limit: number, scale: number) => Math.max(0, value - limit) / scale;

/** People present per location at sample times (seconds). Off-campus is not a place. */
export function occupancySeries(day: DayData, times: number[], filter: (location: string) => boolean): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const stay of day.stays ?? []) {
    if (!filter(stay.location)) continue;
    let row = out.get(stay.location);
    if (!row) { row = new Array(times.length).fill(0); out.set(stay.location, row); }
    for (let i = 0; i < times.length; i++) if (stay.start <= times[i] && times[i] < stay.end) row[i]++;
  }
  return out;
}

/** Walkers on the map in each minute of the day. */
export function walkersPerMinute(day: DayData): number[] {
  const delta = new Float64Array(1441);
  for (const trip of day.trips) {
    const start = Math.max(0, Math.floor(trip.timestamps[0] / 60)), end = Math.min(1440, Math.ceil(trip.timestamps.at(-1)! / 60));
    if (end > start) { delta[start]++; delta[end]--; }
  }
  const out: number[] = [];
  let running = 0;
  for (let minute = 0; minute < 1440; minute++) { running += delta[minute]; out.push(running); }
  return out;
}

export interface ScoreInput {
  label: string;
  day: SourceDay;
  base: DayData;
  data: CampusData;
  weekday: number;
  /** Students simulated ÷ students in the full roster (for a sampled roster). */
  scale?: number;
  bikes?: BikesData;
  /** Which checks apply: 'normal' days are compared with measured series; others get sanity checks. */
  kind?: 'normal' | 'sanity';
}

export function scoreDay(input: ScoreInput): DayScore {
  const { day, data, weekday } = input;
  const scale = input.scale ?? 1;
  const normal = (input.kind ?? 'normal') === 'normal';
  const metrics: Metric[] = [];
  const add = (metric: Metric) => { if (Number.isFinite(metric.value) && Number.isFinite(metric.loss)) metrics.push(metric); };
  const locations = new Map(input.base.locations.map(location => [location.id, location]));
  const kindOf = (id: string) => locations.get(id)?.kind;

  // FitRec: hourly entries for the same weekday in the published week.
  const fitrec = data.fitrecUsage?.observations ?? [];
  const observedByHour = new Array(24).fill(NaN);
  for (const row of fitrec) {
    const date = new Date(`${row.date}T12:00:00Z`);
    if ((date.getUTCDay() + 6) % 7 === weekday) observedByHour[row.hour] = (Number.isNaN(observedByHour[row.hour]) ? 0 : observedByHour[row.hour]) + row.visits;
  }
  const simFitrec = new Array(24).fill(0);
  for (const activity of day.sourceActivities) if (activity.kind === 'gym' && activity.locationId === 'fitrec') simFitrec[Math.floor(activity.startSec / 3600) % 24] += 1 / scale;
  const hours = observedByHour.map((value, hour) => Number.isNaN(value) ? -1 : hour).filter(hour => hour >= 0);
  if (normal && hours.length >= 6) {
    const observed = hours.map(hour => observedByHour[hour]), simulated = hours.map(hour => simFitrec[hour]);
    const r = pearson(observed, simulated);
    add({ id: 'fitrec-hourly-r', label: 'FitRec entries by hour: correlation', value: r, loss: 1 - r, target: 'r → 1', source: 'https://www.bu.edu/fitrec/peak-quiet-hours/', weight: 1 });
    const ratio = simulated.reduce((a, b) => a + b, 0) / Math.max(1, observed.reduce((a, b) => a + b, 0));
    add({ id: 'fitrec-daily-ratio', label: 'FitRec entries per day: simulated ÷ measured', value: ratio, loss: ratioLoss(ratio), target: '1.0', source: 'https://www.bu.edu/fitrec/peak-quiet-hours/', weight: 1 });
    const peakGap = Math.abs(hours[argmax(observed)] - hours[argmax(simulated)]);
    add({ id: 'fitrec-peak-hour', label: 'FitRec busiest hour: simulated − measured (hours)', value: peakGap, loss: peakGap / 6, target: '0', weight: 0.5 });
  }

  // Library: entries by hour vs the School of Theology Library's historical gate counts (shape).
  const libraryHistory = data.libraryHistory?.patronCounts?.filter(row => row.weekday === weekday) ?? [];
  const libraryArrivals = new Array(24).fill(0);
  for (const activity of day.sourceActivities) if (activity.kind === 'library') libraryArrivals[Math.floor(activity.startSec / 3600) % 24] += 1 / scale;
  if (normal && libraryHistory.length >= 6) {
    const rows = libraryHistory.map(row => ({ hour: Number(row.timeLocal.slice(0, 2)), value: row.value }));
    const r = pearson(rows.map(row => row.value), rows.map(row => libraryArrivals[row.hour]));
    add({ id: 'library-hourly-r', label: 'Library entries by hour vs historical gate counts: correlation', value: r, loss: 1 - r, target: 'r → 1',
      source: data.libraryHistory?.sourceUrl, weight: 1 });
  }
  const quarter = Array.from({ length: 96 }, (_, index) => index * 900 + 450);
  const libraries = occupancySeries(day, quarter, id => kindOf(id) === 'library');
  const libraryTotal = quarter.map((_, index) => [...libraries.values()].reduce((sum, row) => sum + row[index], 0));
  const meanOver = (series: number[], from: number, to: number) => {
    const rows = quarter.map((time, index) => [time, series[index]] as const).filter(([time]) => time >= from * 3600 && time < to * 3600);
    return rows.reduce((sum, [, value]) => sum + value, 0) / Math.max(1, rows.length);
  };
  const libraryPeak = Math.max(1, ...libraryTotal);
  if (libraryPeak > 1 && normal) {
    const evening = meanOver(libraryTotal, 19, 22), afternoon = meanOver(libraryTotal, 13, 16);
    add({ id: 'library-evening-vs-afternoon', label: 'Library occupancy 19–22h ÷ 13–16h', value: evening / Math.max(1, afternoon),
      loss: hinge(0.8, evening / Math.max(1, afternoon), 0.8) + hinge(evening / Math.max(1, afternoon), 2.5, 2.5), target: '0.8–2.5 (busy through the afternoon into the evening)', weight: 0.5 });
    let pinned = 0, samples = 0;
    for (const [id, row] of libraries) {
      const capacity = (locations.get(id)?.capacity ?? 0) * scale;
      if (!(capacity > 0)) continue;
      for (let index = 32; index < 96; index++) { samples++; if (row[index] >= 0.98 * capacity) pinned++; }
    }
    add({ id: 'library-pinned-share', label: 'Library samples at ≥98% of capacity (08–24h)', value: pinned / Math.max(1, samples),
      loss: hinge(pinned / Math.max(1, samples), 0.05, 0.2), target: '≤ 5%', weight: 0.5 });
  }

  // Dining: published meal counts at the three main halls, and meals at meal times.
  const dining = occupancySeries(day, quarter, id => kindOf(id) === 'dining');
  const diningTotal = quarter.map((_, index) => [...dining.values()].reduce((sum, row) => sum + row[index], 0));
  if (normal && weekday < 5) {
    const signals = new Map(data.signals.map(signal => [signal.label, signal.value]));
    const published = { breakfast: signals.get('Three main dining halls: breakfasts'), lunch: signals.get('Three main dining halls: lunches'), dinner: signals.get('Three main dining halls: dinners') };
    const meals = { breakfast: 0, lunch: 0, dinner: 0 };
    for (const activity of day.sourceActivities) if (activity.kind === 'dining' && MAIN_HALLS.includes(activity.locationId)) {
      const hour = activity.startSec / 3600;
      for (const [meal, [from, to]] of Object.entries(MEALS)) if (hour >= from && hour < to) meals[meal as keyof typeof meals] += 1 / scale;
    }
    for (const meal of ['lunch', 'dinner'] as const) {
      const target = published[meal];
      if (!target) continue;
      const ratio = meals[meal] / target;
      add({ id: `dining-${meal}-ratio`, label: `Main dining halls, ${meal === 'lunch' ? 'lunches' : 'dinners'}: simulated ÷ published`, value: ratio, loss: ratioLoss(ratio), target: '1.0', source: 'https://www.bu.edu/articles/2017/bu-dining/', weight: 0.75 });
    }
  }
  if (Math.max(...diningTotal) > 0) {
    const mealTimes = (meanOver(diningTotal, 11.5, 13.5) + meanOver(diningTotal, 17.5, 19.5)) / 2, day7to22 = meanOver(diningTotal, 7, 22);
    const ratio = mealTimes / Math.max(1e-9, day7to22);
    add({ id: 'dining-meal-time-ratio', label: 'Dining occupancy at 11:30–13:30 and 17:30–19:30 ÷ 07–22h average', value: ratio, loss: hinge(1.5, ratio, 1.5), target: '≥ 1.5', weight: 0.75 });
    const peak = quarter[argmax(diningTotal)] / 3600;
    const offMeal = !((peak >= 11 && peak < 14) || (peak >= 17 && peak < 20));
    add({ id: 'dining-peak-at-meal', label: 'Busiest dining time (hour)', value: peak, loss: offMeal ? 1 : 0, target: 'within 11–14h or 17–20h', weight: 0.5 });
  }

  // Walking: Bluebikes activity shape (Wednesday profile), pedestrian-count PM/AM ratio, sanity.
  const walkers = walkersPerMinute(day);
  const peakWalkers = Math.max(1, ...walkers);
  if (normal && input.bikes && ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][weekday] === input.bikes.weekday) {
    const bins = Math.round(DAY / input.bikes.binSeconds);
    const bikes = new Array(bins).fill(0);
    for (const station of input.bikes.stations) if ((station.campus ?? 'charles-river') === 'charles-river' && station.profile) {
      for (let index = 0; index < bins; index++) bikes[index] += (station.profile.arrivals[index] ?? 0) + (station.profile.departures[index] ?? 0);
    }
    const departures = new Array(bins).fill(0);
    for (const trip of day.trips) departures[Math.min(bins - 1, Math.floor(trip.timestamps[0] / input.bikes.binSeconds))]++;
    // Hourly sums (the dock profile is a 5-day average of small counts, too noisy per 15 minutes).
    const hourly = (series: number[]) => Array.from({ length: 24 }, (_, hour) => series.slice(hour * bins / 24, (hour + 1) * bins / 24).reduce((a, b) => a + b, 0)).slice(6);
    const r = pearson(hourly(bikes), hourly(departures));
    add({ id: 'bluebikes-hourly-r', label: 'Walk departures vs Bluebikes dock activity by hour (06–24h): correlation', value: r, loss: 1 - r, target: 'r → 1', source: 'https://bluebikes.com/system-data', weight: 0.75 });
  }
  if (normal && weekday < 5) {
    const counts = data.signals.filter(signal => signal.unit === 'pedestrian_crossings_per_hour');
    const am = counts.filter(signal => signal.label.endsWith('08:00-09:00')).reduce((sum, signal) => sum + signal.value, 0);
    const pm = counts.filter(signal => signal.label.endsWith('17:00-18:00')).reduce((sum, signal) => sum + signal.value, 0);
    const simAm = walkers.slice(480, 540).reduce((a, b) => a + b, 0), simPm = walkers.slice(1020, 1080).reduce((a, b) => a + b, 0);
    if (am > 0 && simAm > 0) {
      const ratio = (simPm / simAm) / (pm / am);
      add({ id: 'pedestrian-pm-am', label: 'Walkers 17–18h ÷ 08–09h, relative to published crossing counts', value: ratio, loss: ratioLoss(ratio) / 2, target: '1.0',
        source: 'https://www.bu.edu/community/files/2024/02/Warren-Towers-EPNF.pdf', weight: 0.5 });
    }
  }
  const at3 = walkers[180] / peakWalkers;
  add({ id: 'walkers-3am', label: 'Walkers at 03:00 ÷ peak walkers', value: at3, loss: hinge(at3, 0.01, 0.05), target: '≤ 1%', weight: 1 });
  let spike = 0;
  for (let minute = 1; minute < 1440; minute++) spike = Math.max(spike, (walkers[minute] - walkers[minute - 1]) / peakWalkers);
  add({ id: 'walker-spike', label: 'Largest one-minute jump in walkers ÷ peak', value: spike, loss: hinge(spike, 0.1, 0.2), target: '≤ 10%', weight: 0.75 });
  const durations = day.trips.map(trip => (trip.timestamps.at(-1)! - trip.timestamps[0]) / 60).sort((a, b) => a - b);
  const median = durations[Math.floor(durations.length / 2)] ?? 0;
  add({ id: 'walk-median-minutes', label: 'Median walk (minutes)', value: median, loss: hinge(median, 10, 10), target: '≤ 10', weight: 0.5 });
  const length = (trip: SourceDay['trips'][number]) => { let metres = 0; for (let i = 1; i < trip.path.length; i++) {
    const [a, b] = [trip.path[i - 1], trip.path[i]]; metres += Math.hypot((b[0] - a[0]) * 111320 * Math.cos(a[1] * Math.PI / 180), (b[1] - a[1]) * 110540); } return metres; };
  const long = day.trips.filter(trip => length(trip) > 1500).length / Math.max(1, day.trips.length);
  add({ id: 'walk-long-share', label: 'Walks longer than 1.5 km', value: long, loss: hinge(long, 0.05, 0.1), target: '≤ 5%', weight: 0.5 });
  const access = new Map<string, number>();
  for (const trip of day.trips) if (trip.from === 'off-campus' || trip.to === 'off-campus') access.set(trip.agent, (access.get(trip.agent) ?? 0) + 1);
  const commuters = new Set(input.base.agents.filter(agent => agent.residency === 'commuter' || agent.home === 'off-campus').map(agent => agent.id));
  const commuterTrips = [...access].filter(([agent]) => commuters.has(agent)).map(([, count]) => count);
  if (commuterTrips.length) {
    const many = commuterTrips.filter(count => count >= 4).length / commuterTrips.length;
    add({ id: 'commuter-stop-trips-4plus', label: 'Commuters on campus making 4+ transit-stop walks', value: many, loss: hinge(many, 0.1, 0.3), target: '≤ 10% (2 is typical: in and out)', weight: 1 });
  }
  const outdoorTimes = [3 * 3600, 15 * 3600];
  const outdoor = occupancySeries(day, outdoorTimes, id => id.startsWith('outdoor:'));
  const outdoorAt = (index: number) => [...outdoor.values()].reduce((sum, row) => sum + row[index], 0) / scale;
  add({ id: 'outdoor-3am', label: 'People by the river at 03:00', value: outdoorAt(0), loss: hinge(outdoorAt(0), 5, 50), target: '≈ 0', weight: 0.5 });
  const loss = metrics.reduce((sum, metric) => sum + metric.weight * metric.loss, 0);
  return { day: input.label, metrics, loss };
}

/** Outdoor head count at a time (for scenario sanity checks such as "near zero in heavy rain"). */
export function outdoorAt(day: DayData, time: number): number {
  let count = 0;
  for (const stay of day.stays ?? []) if (stay.location.startsWith('outdoor:') && stay.start <= time && time < stay.end) count++;
  return count;
}

/**
 * Accept a proposal only if no metric gets worse beyond the tolerance and the total improves.
 * Tolerance is absolute on each metric's loss.
 */
export function compareScores(current: DayScore[], proposed: DayScore[], tolerance = 0.02): { accept: boolean; worse: string[]; delta: number } {
  const worse: string[] = [];
  let before = 0, after = 0;
  for (const score of current) {
    const other = proposed.find(row => row.day === score.day);
    if (!other) { worse.push(`${score.day}: missing`); continue; }
    before += score.loss; after += other.loss;
    for (const metric of score.metrics) {
      const next = other.metrics.find(row => row.id === metric.id);
      if (next && next.loss > metric.loss + tolerance) worse.push(`${score.day}/${metric.id}: ${metric.loss.toFixed(3)} → ${next.loss.toFixed(3)}`);
    }
  }
  return { accept: !worse.length && after < before - 1e-9, worse, delta: after - before };
}

/**
 * A reduced roster for fast search: every `step`-th student, with venue, room and activity
 * capacities scaled by the same share so crowding stays comparable. Counts are scaled back up
 * in scoreDay via `scale`.
 */
export function sampleRoster<T extends DayData>(base: T, data: CampusData, step: number): { base: T; data: CampusData; scale: number } {
  if (step <= 1) return { base, data, scale: 1 };
  const agents = base.agents.filter((_, index) => index % step === 0);
  const scale = agents.length / base.agents.length;
  const scaled = (value: number) => Math.max(1, Math.round(value * scale));
  const locations = base.locations.map(location => ({ ...location, capacity: scaled(location.capacity),
    ...(location.referenceCapacity !== undefined ? { referenceCapacity: scaled(location.referenceCapacity) } : {}),
    ...(location.estimatedProfile ? { estimatedProfile: { ...location.estimatedProfile, capacity: scaled(location.estimatedProfile.capacity),
      dailyParticipants: scaled(location.estimatedProfile.dailyParticipants),
      weekdayWindows: location.estimatedProfile.weekdayWindows.map(row => row.dailyParticipants === undefined ? row : { ...row, dailyParticipants: scaled(row.dailyParticipants) }) } } : {}) }));
  const dataLocations: CampusData['locations'] = {};
  for (const [id, location] of Object.entries(data.locations)) {
    dataLocations[id] = { ...location, meetings: location.meetings.map(meeting => meeting.roomCapacity === null ? meeting : { ...meeting, roomCapacity: scaled(meeting.roomCapacity) }) };
  }
  return { base: { ...base, agents, locations }, data: { ...data, locations: dataLocations }, scale };
}
