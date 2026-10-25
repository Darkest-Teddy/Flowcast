// Scores a simulated day against BU's measured series and plain sanity targets. Used headlessly
// by scripts/validate-behavior.mjs and scripts/calibrate-behavior.mjs (never in the browser).
// Every metric has a loss ≥ 0 (lower is better), so a proposal can be checked metric by metric.
import type { CampusData } from '../data/campusData';
import type { DayData } from './playback';
import { isStaff } from './staff';
import type { SourceDay } from './sourceDay';
import { EVERYONE_BAND, pearson as observedPearson, peakHoursApart, seriesForWeekday, simulatedPedestrians, simulatedTransit, smoothObservedBins,
  type CalibrationObservations, type ObservationBin } from '../data/observations';

export interface Metric {
  id: string;
  label: string;
  value: number;
  /** ≥ 0, lower is better; 0 means on target. */
  loss: number;
  target: string;
  source?: string;
  /** Assumptions receive reduced weight; zero excludes incomparable proxies and reconstructions. */
  weight: number;
  basis?: MetricBasis;
}
export interface DayScore { day: string; metrics: Metric[]; loss: number }

export type MetricBasis = 'historical comparison' | 'indirect proxy' | 'historical context' | 'input reconstruction' | 'assumed sanity target';

export const ASSUMPTION_WEIGHT_SCALE = 0.1;

/** Distinguish measured comparisons from modeling assumptions and reconstruction checks. */
export function metricBasis(id: string): MetricBasis {
  if (['obs-bu-b-line-shape', 'obs-bu-b-line-peak', 'obs-comm-ave-shape', 'obs-comm-ave-peak',
    'obs-student-count-excess', 'pedestrian-pm-am'].includes(id)) return 'historical comparison';
  if (['fitrec-hourly-r', 'fitrec-peak-hour', 'obs-everyone-shape', 'obs-everyone-ratio'].includes(id)) return 'input reconstruction';
  if (['fitrec-daily-ratio', 'bluebikes-hourly-r'].includes(id)) return 'indirect proxy';
  if (id === 'library-hourly-r' || /^dining-(lunch|dinner)-ratio$/.test(id)) return 'historical context';
  return 'assumed sanity target';
}

function classified(metric: Metric): Metric {
  const basis = metricBasis(metric.id);
  return { ...metric, basis, weight: basis === 'historical comparison' ? metric.weight : basis === 'assumed sanity target' ? metric.weight * ASSUMPTION_WEIGHT_SCALE : 0 };
}

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
  /** MBTA ridership and pedestrian counts (data/observations.ts), scored on normal days. */
  observations?: CalibrationObservations;
}

export function scoreDay(input: ScoreInput): DayScore {
  const { day, data, weekday } = input;
  const scale = input.scale ?? 1;
  const normal = (input.kind ?? 'normal') === 'normal';
  const metrics: Metric[] = [];
  const add = (metric: Metric) => { if (Number.isFinite(metric.value) && Number.isFinite(metric.loss)) metrics.push(classified(metric)); };
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
    add({ id: 'fitrec-hourly-r', label: 'FitRec input-profile reconstruction: hourly correlation', value: r, loss: 1 - r, target: 'r → 1', source: 'https://www.bu.edu/fitrec/peak-quiet-hours/', weight: 0 });
    const ratio = simulated.reduce((a, b) => a + b, 0) / Math.max(1, observed.reduce((a, b) => a + b, 0));
    add({ id: 'fitrec-daily-ratio', label: 'FitRec entries per day: simulated ÷ measured', value: ratio, loss: ratioLoss(ratio), target: '1.0', source: 'https://www.bu.edu/fitrec/peak-quiet-hours/', weight: 1 });
    const peakGap = Math.abs(hours[argmax(observed)] - hours[argmax(simulated)]);
    add({ id: 'fitrec-peak-hour', label: 'FitRec input-profile reconstruction: peak gap (hours)', value: peakGap, loss: peakGap / 6, target: '0', weight: 0 });
  }

  // Historical patron/zone aggregates have an unknown counting method; retain as context only.
  const libraryHistory = data.libraryHistory?.patronCounts?.filter(row => row.weekday === weekday) ?? [];
  const libraryArrivals = new Array(24).fill(0);
  for (const activity of day.sourceActivities) if (activity.kind === 'library' && activity.locationId === 'theology-library') libraryArrivals[Math.floor(activity.startSec / 3600) % 24] += 1 / scale;
  if (normal && libraryHistory.length >= 6) {
    const rows = libraryHistory.map(row => ({ hour: Number(row.timeLocal.slice(0, 2)), value: row.value }));
    const r = pearson(rows.map(row => row.value), rows.map(row => libraryArrivals[row.hour]));
    add({ id: 'library-hourly-r', label: 'Theology Library entries vs historical patron/zone counts (method unknown): correlation', value: r, loss: 1 - r, target: 'r → 1',
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
  if (normal && input.observations) {
    // Compare the same intersection crossings in the same two measured intervals, not
    // campus-wide walker-minutes against point counts. Only paired source bins contribute.
    let am = 0, pm = 0, simAm = 0, simPm = 0;
    const sites = seriesForWeekday(input.observations, weekday, { primaryOnly: true }).pedestrian;
    for (const site of sites.filter(site => site.source === 'bu-warren-epnf-2024')) {
      const morning = site.bins.findIndex(bin => bin.start === '08:00' && bin.end === '09:00');
      const evening = site.bins.findIndex(bin => bin.start === '17:00' && bin.end === '18:00');
      if (morning < 0 || evening < 0) continue;
      const simulated = simulatedPedestrians(day.trips, site);
      am += site.bins[morning].value; pm += site.bins[evening].value;
      simAm += simulated[morning] / scale; simPm += simulated[evening] / scale;
    }
    if (am > 0 && pm > 0 && simAm > 0) {
      const ratio = (simPm / simAm) / (pm / am);
      add({ id: 'pedestrian-pm-am', label: 'Survey-site crossings 17–18h ÷ 08–09h, relative to observed crossings', value: ratio, loss: ratioLoss(ratio) / 2, target: '1.0',
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
  if (normal && input.observations) for (const metric of scoreObservations(input.observations, day, weekday, scale, staffIds(input.base)).metrics) add(metric);
  const loss = metrics.reduce((sum, metric) => sum + metric.weight * metric.loss, 0);
  return { day: input.label, metrics, loss };
}

// ── Observed MBTA ridership and pedestrian counts (data/observations.ts) ──────────────────────
// Students are the only people in university buildings, but streets and the T carry everyone. The
// public crowd (sim/publicCrowd.ts) fills observed − students wherever students fall short, so
// students + public match the counts by construction except where students alone exceed them.
// What the student model controls, and what is scored, is therefore: the timing of the students'
// own peaks at BU-dominated places (the B branch's BU stops, Comm Ave crossings), weighted like
// the library; and students exceeding their plausible share of a count (a band penalty on
// magnitude). Combined student/public fits are reconstruction diagnostics only.

/** B branch stops on BU's frontage (expected student share 0.55–0.85). */
export const BU_STOPS = ['place-bland', 'place-buest', 'place-bucen', 'place-amory', 'place-babck'];
const COMM_AVE = /^ped-(cds-2018|tmp-2012)-comm-/;

export interface ObservationGroup {
  id: string;
  label: string;
  series: number;
  /** Observed-volume-weighted mean Pearson r, students only (null: no series with a defined r). */
  shape: number | null;
  peakHours: number | null;
  /** Students ÷ observed, all bins of the group. */
  ratio: number | null;
  /** Students above observed × the series' high student share, ÷ observed (0 = never). */
  overflow: number;
}
export interface ObservationScore {
  groups: ObservationGroup[];
  /** Students + staff + public (the public fill rule of publicCrowd.ts): median r and median ratio over every scored series. */
  everyone: { series: number; medianShape: number | null; medianRatio: number | null };
  studentsOnly: { series: number; medianShape: number | null; medianRatio: number | null };
  kenmoreStudentEntries: number;
  metrics: Metric[];
}

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
/** Simulated BU employees (sim/staff.ts) in a roster. */
export const staffIds = (base: DayData): ReadonlySet<string> => new Set(base.agents.filter(isStaff).map(agent => agent.id));

/**
 * `staff`: employee ids. The student metrics (timing, overflow above the students' plausible share)
 * use students only; "everyone" is students + employees + the public fill, which covers only what
 * the simulated BU people leave (as publicCrowd.ts does).
 */
export function scoreObservations(observations: CalibrationObservations, day: Pick<SourceDay, 'trips' | 'transitRides'>, weekday: number, scale = 1,
  staff: ReadonlySet<string> = new Set()): ObservationScore {
  const { transit, pedestrian } = seriesForWeekday(observations, weekday, { primaryOnly: true });
  type Row = { id: string; bins: ObservationBin[]; observed: number[]; students: number[]; bu: number[]; high: number; transit: boolean };
  const rows: Row[] = [];
  const rides = day.transitRides ?? [], studentRides = staff.size ? rides.filter(ride => !staff.has(ride.agent)) : rides;
  const studentTrips = staff.size ? day.trips.filter(trip => !staff.has(trip.agent)) : day.trips;
  for (const series of transit) {
    const students = simulatedTransit(studentRides, series).map(v => v / scale);
    rows.push({ id: series.id, bins: series.bins, observed: series.bins.map(b => b.value), students,
      bu: staff.size ? simulatedTransit(rides, series).map(v => v / scale) : students, high: series.expectedStudentShare[1], transit: true });
  }
  for (const site of pedestrian) {
    const students = simulatedPedestrians(studentTrips, site).map(v => v / scale);
    rows.push({ id: site.id, bins: site.bins, observed: site.bins.map(b => b.value), students,
      bu: staff.size ? simulatedPedestrians(day.trips, site).map(v => v / scale) : students, high: site.expectedStudentShare[1], transit: false });
  }
  const byId = new Map(rows.map(row => [row.id, row]));
  const group = (id: string, label: string, members: Row[]): ObservationGroup => {
    let rWeight = 0, rSum = 0, pWeight = 0, pSum = 0, observedTotal = 0, studentTotal = 0, over = 0;
    for (const row of members) {
      const observed = row.observed.reduce((a, b) => a + b, 0), students = row.students.reduce((a, b) => a + b, 0);
      observedTotal += observed; studentTotal += students;
      row.observed.forEach((value, i) => { over += Math.max(0, row.students[i] - value * row.high); });
      const r = observedPearson(row.observed, row.students);
      if (r !== null) { rSum += r * observed; rWeight += observed; }
      // Busiest bins after 1-2-1 smoothing on both sides, so one noisy bin can't move the peak by hours.
      const peak = peakHoursApart(row.bins, smoothObservedBins(row.observed, row.bins), smoothObservedBins(row.students, row.bins));
      if (peak !== null) { pSum += peak * observed; pWeight += observed; }
    }
    return { id, label, series: members.length, shape: rWeight ? rSum / rWeight : null, peakHours: pWeight ? pSum / pWeight : null,
      ratio: observedTotal ? studentTotal / observedTotal : null, overflow: observedTotal ? over / observedTotal : 0 };
  };
  // B branch BU stops: ons and offs per stop, both directions added (the doc's robust form for small counts).
  const buStops: Row[] = [];
  for (const stop of BU_STOPS) for (const kind of ['apc-boardings', 'apc-alightings']) {
    const parts = transit.filter(series => series.stop.mapStopId === stop && series.kind === kind && series.route === 'Green-B').map(series => byId.get(series.id)!);
    if (!parts.length) continue;
    buStops.push({ id: `${stop}-${kind}`, bins: parts[0].bins, observed: parts[0].observed.map((_, i) => parts.reduce((sum, row) => sum + row.observed[i], 0)),
      students: parts[0].students.map((_, i) => parts.reduce((sum, row) => sum + row.students[i], 0)),
      bu: parts[0].bu.map((_, i) => parts.reduce((sum, row) => sum + row.bu[i], 0)), high: parts[0].high, transit: true });
  }
  const groups = [
    group('bu-b-line', 'Green Line B, BU stops (ons and offs)', buStops),
    group('comm-ave', 'Comm Ave crossings (2018 15-min, 2012 midday)', rows.filter(row => COMM_AVE.test(row.id))),
    group('c-line', 'Green Line C and D (St Mary’s, Hawes, Kent, Fenway, Longwood)', rows.filter(row => row.transit && /^green-[cd]-/.test(row.id) && !row.id.includes('kencl'))),
    group('kenmore', 'Kenmore (gated entries and Green Line at Kenmore)', rows.filter(row => row.transit && (/kencl|kenmore/.test(row.id)))),
    group('bus', 'Buses (routes 1, 8, 10, 47, 57, 749, 751)', rows.filter(row => row.transit && !row.id.startsWith('green') && !/kencl|kenmore|gse/.test(row.id))),
    group('pedestrian', 'All pedestrian count sites', rows.filter(row => !row.transit)),
    group('all', 'Every scored series', rows),
  ];
  const everyoneShapes: number[] = [], everyoneRatios: number[] = [], studentShapes: number[] = [], studentRatios: number[] = [];
  for (const row of rows) {
    const observedTotal = row.observed.reduce((a, b) => a + b, 0);
    if (!(observedTotal > 0)) continue;
    const smoothed = row.transit ? smoothObservedBins(row.bu, row.bins) : row.bu;
    const everyone = row.bu.map((v, i) => v + Math.max(0, row.observed[i] - smoothed[i]));
    const r = observedPearson(row.observed, everyone), rs = observedPearson(row.observed, row.students);
    if (r !== null) everyoneShapes.push(r);
    if (rs !== null) studentShapes.push(rs);
    everyoneRatios.push(everyone.reduce((a, b) => a + b, 0) / observedTotal);
    studentRatios.push(row.students.reduce((a, b) => a + b, 0) / observedTotal);
  }
  const kenmore = transit.filter(series => series.kind === 'gated-entries').reduce((sum, series) => sum + simulatedTransit(day.transitRides ?? [], series).reduce((a, b) => a + b, 0) / scale, 0);
  const g = (id: string) => groups.find(row => row.id === id)!;
  const metrics: Metric[] = [];
  const push = (metric: Metric) => { if (Number.isFinite(metric.value) && Number.isFinite(metric.loss)) metrics.push(classified(metric)); };
  for (const id of ['bu-b-line', 'comm-ave']) {
    const row = g(id);
    if (row.shape !== null) push({ id: `obs-${id}-shape`, label: `${row.label}: students’ timing vs counts (r)`, value: row.shape, loss: 1 - row.shape, target: 'r → 1',
      source: id === 'comm-ave' ? 'https://www.bu.edu/community/files/2018/10/BU-Data-Sciences-Center-PNF-Final-Draft-9-27-18.pdf' : 'https://mbta-massdot.opendata.arcgis.com/datasets/6494749a29c648018820d0e49636205c', weight: 1 });
    if (row.peakHours !== null) push({ id: `obs-${id}-peak`, label: `${row.label}: students’ busiest hour vs counted (hours apart)`, value: row.peakHours, loss: row.peakHours / 6, target: '0', weight: 0.5 });
  }
  const all = g('all');
  const observedTotal = rows.reduce((sum, row) => sum + row.observed.reduce((a, b) => a + b, 0), 0);
  const excess = rows.reduce((sum, row) => sum + row.observed.reduce((total, count, i) => total + Math.max(0, row.students[i] - count), 0), 0);
  if (observedTotal > 0) push({ id: 'obs-student-count-excess', label: 'Student trips above historical all-person counts, divided by observed trips',
    value: excess / observedTotal, loss: excess / observedTotal, target: '0 (historical count comparison)', weight: 1 });
  push({ id: 'obs-student-overflow', label: 'Students above their plausible share of a count (all series, share of counted people)', value: all.overflow,
    loss: hinge(all.overflow, 0.01, 0.2), target: '≤ 1% (band penalty)', source: 'docs/calibration-observations.md', weight: 1 });
  const everyoneShape = median(everyoneShapes), everyoneRatio = median(everyoneRatios);
  if (everyoneShape !== null) push({ id: 'obs-everyone-shape', label: 'Students, staff and public reconstruction: median r', value: everyoneShape, loss: 1 - everyoneShape, target: 'r → 1', weight: 0 });
  if (everyoneRatio !== null) push({ id: 'obs-everyone-ratio', label: 'Students, staff and public vs every count: median total ratio', value: everyoneRatio,
    loss: hinge(EVERYONE_BAND[0], everyoneRatio, 0.5) + hinge(everyoneRatio, EVERYONE_BAND[1], 0.5), target: `${EVERYONE_BAND[0]}–${EVERYONE_BAND[1]}`, weight: 0 });
  return { groups, everyone: { series: everyoneRatios.length, medianShape: everyoneShape, medianRatio: everyoneRatio },
    studentsOnly: { series: studentRatios.length, medianShape: median(studentShapes), medianRatio: median(studentRatios) }, kenmoreStudentEntries: kenmore, metrics };
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
  if (!Number.isFinite(tolerance) || tolerance < 0) worse.push('invalid tolerance');
  for (const scores of [current, proposed]) {
    const days = new Set<string>();
    for (const score of scores) {
      if (days.has(score.day)) worse.push(`${score.day}: duplicate day`);
      days.add(score.day);
      if (!Number.isFinite(score.loss) || score.loss < 0) worse.push(`${score.day}: invalid loss`);
      const ids = new Set<string>();
      for (const metric of score.metrics) {
        if (ids.has(metric.id)) worse.push(`${score.day}/${metric.id}: duplicate metric`);
        ids.add(metric.id);
        if (!Number.isFinite(metric.loss) || metric.loss < 0) worse.push(`${score.day}/${metric.id}: invalid loss`);
      }
    }
  }
  for (const score of proposed) if (!current.some(row => row.day === score.day)) worse.push(`${score.day}: unexpected day`);
  for (const score of current) {
    const other = proposed.find(row => row.day === score.day);
    if (!other) { worse.push(`${score.day}: missing`); continue; }
    before += score.loss; after += other.loss;
    for (const metric of score.metrics) {
      const next = other.metrics.find(row => row.id === metric.id);
      if (!next) worse.push(`${score.day}/${metric.id}: missing metric`);
      else if (next.weight !== metric.weight) worse.push(`${score.day}/${metric.id}: changed weight`);
      else if (metric.weight !== 0 && metric.basis !== 'assumed sanity target' && next.loss > metric.loss + tolerance) worse.push(`${score.day}/${metric.id}: ${metric.loss.toFixed(3)} → ${next.loss.toFixed(3)}`);
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
