import { carriedForwardHours, dateForWeekday, openingHoursForDate, type CampusData } from '../data/campusData';
import { effectiveMeetingIntervals } from '../data/academicCalendar';
import type { Agent, DayData, EstimatedActivityProfile, EstimatedHousingProfile } from './playback';
import { countsTowardDegreeLoad, eligibleStudentLevels } from './courseEligibility';

export interface PopulationData {
  schemaVersion: 1;
  students: { total: number; undergraduate: number; graduate: number; reportingPeriod: string;
    cohorts: { level: 'undergraduate' | 'graduate'; attendance: 'full-time' | 'part-time'; headcount: number }[] };
  housing: { estimatedUndergraduateResidents: number };
  locationCapacities: Record<string, number>;
  residentialCapacities: Record<string, number>;
  locationNames?: Record<string, string>;
  locationEstimatedProfiles?: Record<string, EstimatedActivityProfile>;
  estimatedHousingProfiles?: Record<string, EstimatedHousingProfile>;
  locationCapacityBasis?: Record<string, { basis: string }>;
  campusResidentMinimums?: { campus: string; students: number; sourceUrl: string; basis: string }[];
  sources: { url: string }[];
}
export interface PopulationSummary {
  total: number; mappedResidents: number; residentsOutsideMap: number; commuters: number;
  reportingPeriod: string; campusAllocation: string; estimatedGraduateResidents: number; estimatedMappedResidents: number;
}
export interface PopulationBase extends DayData { populationSummary: PopulationSummary }

function hash(key: string) {
  let n = 2166136261;
  for (let i = 0; i < key.length; i++) n = Math.imul(n ^ key.charCodeAt(i), 16777619);
  return (n >>> 0) / 4294967296;
}

export function campusOfferingWeights(base: DayData, source: CampusData): Record<string, { undergraduate: number; graduate: number }> {
  const locations = new Map(base.locations.map(location => [location.id, location]));
  const weights: Record<string, { undergraduate: number; graduate: number }> = {};
  for (const campus of base.campuses?.map(c => c.id) ?? ['charles-river']) weights[campus] = { undergraduate: 0, graduate: 0 };
  const parent = new Map<string, string>();
  const rows: { key: string; campus: string; course: string; seats: number }[] = [];
  const shared = new Map<string, string>();
  const find = (key: string): string => {
    const next = parent.get(key)!;
    if (next === key) return key;
    const root = find(next); parent.set(key, root); return root;
  };
  for (const location of Object.values(source.locations)) {
    const mapped = locations.get(location.id);
    if (!mapped) continue;
    const campus = mapped.campus ?? 'charles-river';
    weights[campus] ??= { undergraduate: 0, graduate: 0 };
    for (const meeting of location.meetings) {
      if (meeting.calendarRestricted || !countsTowardDegreeLoad(meeting.courseCode)) continue;
      if ((source.academicCalendar || meeting.validFrom || meeting.validTo) && !effectiveMeetingIntervals(meeting, source).length) continue;
      const key = `${campus}:${meeting.sourceSectionKey ?? `${meeting.courseCode}:${meeting.section}`}`;
      if (!parent.has(key)) parent.set(key, key);
      if (meeting.sharedKey) {
        const signature = `${campus}:${meeting.sharedKey}`;
        const existing = shared.get(signature);
        if (existing) parent.set(find(key), find(existing));
        else shared.set(signature, key);
      }
      const seats = meeting.roomCapacity !== null && Number.isFinite(meeting.roomCapacity)
        ? Math.max(0, meeting.roomCapacity) : 24;
      rows.push({ key, campus, course: meeting.courseCode, seats });
    }
  }
  const groups = new Map<string, { campus: string; seats: number; levels: Set<'undergraduate' | 'graduate'> }>();
  for (const row of rows) {
    const key = find(row.key);
    const group = groups.get(key) ?? { campus: row.campus, seats: row.seats, levels: new Set() };
    group.seats = Math.min(group.seats, row.seats);
    for (const level of eligibleStudentLevels(row.course)) group.levels.add(level);
    groups.set(key, group);
  }
  for (const group of groups.values()) for (const level of group.levels) weights[group.campus][level] += group.seats;
  return weights;
}

/** The institutional roster includes people outside the mapped study area. */
export function buildPopulation(base: DayData, source: CampusData, population: PopulationData): PopulationBase {
  const cohorts = population.students.cohorts;
  if (cohorts.some((c) => !Number.isInteger(c.headcount) || c.headcount < 0)
    || cohorts.reduce((sum, c) => sum + c.headcount, 0) !== population.students.total) throw new Error('Population cohorts do not match the published total');
  const residentCount = population.housing.estimatedUndergraduateResidents;
  if (!Number.isInteger(residentCount) || residentCount < 0 || residentCount > population.students.undergraduate
    || cohorts.filter((c) => c.level === 'undergraduate').reduce((n, c) => n + c.headcount, 0) !== population.students.undergraduate
    || new Set(cohorts.map((c) => `${c.level}:${c.attendance}`)).size !== cohorts.length) throw new Error('Invalid population cohorts or housing estimate');
  for (const capacity of Object.values(population.residentialCapacities)) {
    if (!Number.isInteger(capacity) || capacity < 0) throw new Error('Invalid residential capacity');
  }
  const locations = base.locations.map((location) => {
    const published = source.locations[location.id];
    const openThisWeek = published?.hoursStatus !== 'restricted' && Array.from({ length: 7 }, (_, weekday) =>
      [...openingHoursForDate(published?.hours ?? [], dateForWeekday(source, weekday), weekday),
        ...carriedForwardHours(published?.hours ?? [], dateForWeekday(source, weekday), weekday)].some(h => h.windows.length > 0)).some(Boolean);
    return { ...location, name: population.locationNames?.[location.id] ?? location.name,
      short: population.locationNames?.[location.id] ?? location.short,
      capacity: population.locationCapacities[location.id] ?? location.capacity,
      referenceCapacity: population.locationCapacities[location.id] ?? location.capacity,
      capacityBasis: population.locationCapacityBasis?.[location.id]?.basis,
      estimatedProfile: population.locationEstimatedProfiles?.[location.id],
      estimatedHousingProfile: population.estimatedHousingProfiles?.[location.id],
      activityModeled: (population.residentialCapacities[location.id] ?? 0) > 0
        || (published?.meetings.length ?? 0) > 0 || openThisWeek
        || !!population.locationEstimatedProfiles?.[location.id] || !!population.estimatedHousingProfiles?.[location.id] };
  });
  const campuses = base.campuses?.map((c) => c.id) ?? ['charles-river'];
  const offeringWeights = campusOfferingWeights(base, source);
  const campusFor = (id: string, level: 'undergraduate' | 'graduate') => {
    // The fact sheet lists Medical graduate/nondegree FTE, without an undergraduate category.
    if (level === 'undergraduate' && campuses.includes('charles-river')) return 'charles-river';
    const weights = campuses.map(campus => offeringWeights[campus]?.[level] ?? 0);
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    if (!totalWeight) return campuses.includes('charles-river') ? 'charles-river' : campuses[0];
    let point = hash(`campus:${id}`) * totalWeight;
    for (let i = 0; i < campuses.length; i++) { point -= weights[i]; if (point < 0) return campuses[i]; }
    return campuses[0];
  };
  // Only sourced whole-residence capacities provide mapped residential slots.
  const beds: { location: string; campus: string }[] = [];
  for (const location of locations.filter((l) => l.kind === 'dorm')) {
    const capacity = population.residentialCapacities[location.id] ?? 0;
    for (let i = 0; i < capacity; i++) beds.push({ location: location.id, campus: location.campus ?? 'charles-river' });
  }
  const agents: Agent[] = [];
  for (const cohort of cohorts) for (let i = 0; i < cohort.headcount; i++) {
    const id = `${cohort.level}:${cohort.attendance}:${i}`;
    const academicCampus = campusFor(id, cohort.level);
    agents.push({ id, home: 'off-campus', residency: 'commuter', studentLevel: cohort.level,
      attendance: cohort.attendance, campus: academicCampus, academicCampus, model: Math.floor(hash(`model:${id}`) * 12),
      walkSpeed: 1.4 });
  }
  const residents = agents.filter((a) => a.studentLevel === 'undergraduate')
    .sort((a, b) => hash(`residence:${a.id}`) - hash(`residence:${b.id}`))
    .slice(0, population.housing.estimatedUndergraduateResidents);
  let mappedResidents = 0;
  for (let i = 0; i < residents.length; i++) {
    residents[i].residency = 'resident';
    if (i < beds.length) { residents[i].home = beds[i].location; residents[i].campus = beds[i].campus; mappedResidents++; }
  }
  const relocated = new Set<string>();
  for (const minimum of population.campusResidentMinimums ?? []) {
    if (!campuses.includes(minimum.campus) || !Number.isInteger(minimum.students) || minimum.students < 0) throw new Error('Invalid campus resident minimum');
    const existing = residents.filter((agent) => agent.campus === minimum.campus).length;
    let remaining = Math.max(0, minimum.students - existing);
    for (const agent of residents) {
      if (!remaining) break;
      if (agent.home !== 'off-campus' || agent.campus === minimum.campus || relocated.has(agent.id)) continue;
      agent.campus = minimum.campus;
      relocated.add(agent.id); remaining--;
    }
    if (remaining) throw new Error('Campus resident minimum exceeds available unmapped residents');
  }
  let estimatedGraduateResidents = 0, estimatedMappedResidents = 0;
  const graduatePool = agents.filter(agent => agent.studentLevel === 'graduate' && agent.home === 'off-campus')
    .sort((a, b) => hash(`graduate-housing:${a.id}`) - hash(`graduate-housing:${b.id}`));
  const housingProfiles = Object.values(population.estimatedHousingProfiles ?? {}).sort((a, b) =>
    Number(b.campus === 'fenway') - Number(a.campus === 'fenway') || a.locationId.localeCompare(b.locationId));
  for (const profile of housingProfiles) {
    if (!Number.isInteger(profile.capacity) || profile.capacity < 0 || !Number.isFinite(profile.occupancyRate)
      || profile.occupancyRate < 0 || profile.occupancyRate > 1 || !locations.some(l => l.id === profile.locationId && l.kind === 'dorm')) throw new Error('Invalid estimated housing profile');
    const count = Math.round(profile.capacity * profile.occupancyRate);
    const pool = (profile.studentLevel === 'graduate' ? graduatePool : residents).filter(agent =>
      agent.home === 'off-campus' && (profile.studentLevel === 'graduate' || agent.campus === profile.campus || !relocated.has(agent.id)))
      .sort((a, b) => Number(b.campus === profile.campus) - Number(a.campus === profile.campus));
    if (pool.length < count) throw new Error('Estimated housing exceeds available existing residents');
    for (const agent of pool.slice(0, count)) {
      agent.home = profile.locationId; agent.campus = profile.campus; agent.residency = 'resident';
      mappedResidents++; estimatedMappedResidents++;
      if (profile.studentLevel === 'graduate') estimatedGraduateResidents++;
    }
  }
  return { ...base, agents, locations, trips: [], populationSummary: {
    total: agents.length, mappedResidents, residentsOutsideMap: residents.filter(a => a.home === 'off-campus').length, estimatedGraduateResidents, estimatedMappedResidents,
    commuters: agents.length - residents.length - estimatedGraduateResidents, reportingPeriod: population.students.reportingPeriod,
    campusAllocation: 'Undergraduate primary campus starts at Charles River, consistent with FY2026 campus FTE categories; housing assignments and the Fenway relocation plan then apply. Graduate primary campuses use eligible weekly section seat weights, counting cross-listed sections once. FTE is context, not a headcount conversion; online enrollment and actual campus headcounts remain unknown.',
  } };
}

export async function loadPopulation(url = '/data/population.json'): Promise<PopulationData> {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Population data unavailable');
  const data = await response.json();
  if (data.schemaVersion !== 1 || !data.students?.cohorts || !data.locationCapacities || !data.residentialCapacities) throw new Error('Unsupported population data');
  return data;
}
