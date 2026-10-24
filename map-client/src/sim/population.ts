import type { CampusData } from '../data/campusData';
import type { Agent, DayData } from './playback';

export interface PopulationData {
  schemaVersion: 1;
  students: { total: number; undergraduate: number; graduate: number; reportingPeriod: string;
    cohorts: { level: 'undergraduate' | 'graduate'; attendance: 'full-time' | 'part-time'; headcount: number }[] };
  housing: { estimatedUndergraduateResidents: number };
  locationCapacities: Record<string, number>;
  residentialCapacities: Record<string, number>;
  sources: { url: string }[];
}
export interface PopulationSummary {
  total: number; mappedResidents: number; residentsOutsideMap: number; commuters: number;
  reportingPeriod: string; campusAllocation: string;
}
export interface PopulationBase extends DayData { populationSummary: PopulationSummary }

function hash(key: string) {
  let n = 2166136261;
  for (let i = 0; i < key.length; i++) n = Math.imul(n ^ key.charCodeAt(i), 16777619);
  return (n >>> 0) / 4294967296;
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
  const locations = base.locations.map((location) => ({ ...location, capacity: population.locationCapacities[location.id] ?? location.capacity }));
  const campuses = base.campuses?.map((c) => c.id) ?? ['charles-river'];
  const weights = campuses.map((campus) => {
    const ids = new Set(locations.filter((l) => l.campus === campus).map((l) => l.id));
    return Math.max(1, Object.values(source.locations).filter((l) => ids.has(l.id))
      .reduce((sum, l) => sum + l.meetings.filter((m) => !m.calendarRestricted).reduce((n, m) => n + (m.roomCapacity ?? 24), 0), 0));
  });
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const campusFor = (id: string) => {
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
    agents.push({ id, home: 'off-campus', residency: 'commuter', studentLevel: cohort.level,
      attendance: cohort.attendance, campus: campusFor(id), model: Math.floor(hash(`model:${id}`) * 12),
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
  return { ...base, agents, locations, trips: [], populationSummary: {
    total: agents.length, mappedResidents, residentsOutsideMap: residents.length - mappedResidents,
    commuters: agents.length - residents.length, reportingPeriod: population.students.reportingPeriod,
    campusAllocation: 'Synthetic course-capacity allocation; campus headcounts and online enrollment are unavailable.',
  } };
}

export async function loadPopulation(url = '/data/population.json'): Promise<PopulationData> {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Population data unavailable');
  const data = await response.json();
  if (data.schemaVersion !== 1 || !data.students?.cohorts || !data.locationCapacities || !data.residentialCapacities) throw new Error('Unsupported population data');
  return data;
}
