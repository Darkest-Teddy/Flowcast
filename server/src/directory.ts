// What the chat can answer from: every dataset with its provenance, period, public source page
// (only URLs recorded in the repo's data files and data-pipeline scripts; null when there is none)
// and coverage counted from the loaded data, grouped into domains for GET /api/chat/directory.
// The same catalog gives each answer its citations (citationsFor).

import type { Citation, DataDomain, Provenance } from '../../map-client/src/chatContract';
import { dateForWeekday } from '../../map-client/src/data/campusData';
import type { CampusModel } from './campus';
import { SOURCE_URLS } from './chatData';

export type DatasetId =
  | 'simulation' | 'enrollment' | 'capacityBasis' | 'assumptions'
  | 'diningHours' | 'libraryHours' | 'fitrecHours' | 'evidence'
  | 'classSchedule' | 'walkRoutes'
  | 'terrierCentral' | 'eventImpact' | 'venueCalendar'
  | 'mbta' | 'shuttle' | 'bluebikes' | 'parking'
  | 'housing' | 'cdsHousing' | 'factSheet'
  | 'fitrecCounts' | 'pedestrianCounts' | 'libraryGateCounts' | 'calibration' | 'validationScores'
  | 'scenarios' | 'behaviour' | 'academicCalendar'
  | 'fireNetwork' | 'incidentModel';

export interface Dataset {
  name: string;
  domain: string;
  kind: Provenance;
  period: string | null;
  url: string | null;
  coverage: string | null;
}

const n = (x: number) => x.toLocaleString('en-US');
const plural = (x: number, one: string, many = `${one}s`) => `${n(x)} ${x === 1 ? one : many}`;

/** Every dataset, with coverage counted from what was loaded ("not loaded" when a file is missing). */
export function datasetCatalog(campus: CampusModel): Record<DatasetId, Dataset> {
  const f = campus.facts;
  const data = f.data;
  const chat = f.chat;
  const week = `${data.referenceWeekStart} to ${dateForWeekday(data, 6)}`;
  const kinds = (kind: string) => campus.locations.filter((l) => l.kind === kind);
  const published = (kind: string) => kinds(kind).filter((l) => data.locations[l.id]?.hoursStatus === 'published').length;
  const evidence = Object.values(data.locations).reduce((a, l) => a + (l.evidence?.length ?? 0), 0);
  const mapped = data.events.filter((e) => e.locationId).length;
  const ei = chat?.eventImpact;
  const eiDates = ei ? Object.keys(ei.dates).sort() : [];
  const gatherings = ei ? Object.values(ei.dates).reduce((a, d) => a + d.gatherings.length, 0) : 0;
  const fit = data.fitrecUsage;
  const dorms = kinds('dorm');
  const pop = chat?.population;
  const metrics = chat?.validation?.metrics ?? [];
  const conditionsMods = (chat?.modifiers ?? []).filter((m) => m.group === 'conditions').length;
  const fittedMods = (chat?.modifiers ?? []).filter((m) => m.group === 'calibration').length;
  const terms = data.academicCalendar?.terms ?? [];
  const meetings = campus.meetings.length;
  const meetingBuildings = new Set(campus.meetings.map((m) => m.locationId)).size;
  const missing = 'not loaded';
  return {
    simulation: { name: 'Flowcast simulated students, reference week', domain: 'crowds', kind: 'simulated', period: week, url: null, coverage: `${n(f.populationSummary.total)} simulated students, ${n(campus.locations.length)} places` },
    enrollment: { name: 'BU Common Data Set 2025–26, enrollment (B1)', domain: 'population', kind: 'published', period: f.populationSummary.reportingPeriod, url: SOURCE_URLS.cdsEnrollment, coverage: `${n(f.populationSummary.total)} students` },
    capacityBasis: { name: 'Place capacities with their basis', domain: 'crowds', kind: 'mixed', period: null, url: null, coverage: plural(Object.keys(f.basis).length, 'place') },
    assumptions: { name: 'Simulation assumptions (crowd levels, capacity, visits)', domain: 'crowds', kind: 'assumption', period: null, url: null, coverage: `${n(data.assumptions.length)} stated assumptions` },
    diningHours: { name: 'BU Dining locations and opening hours', domain: 'places', kind: 'published', period: week, url: SOURCE_URLS.dining, coverage: `${n(published('dining'))} of ${n(kinds('dining').length)} dining places with published hours` },
    libraryHours: { name: 'BU Libraries opening hours', domain: 'places', kind: 'published', period: week, url: SOURCE_URLS.libraryHours, coverage: `${n(published('library'))} of ${n(kinds('library').length)} libraries with published hours` },
    fitrecHours: { name: 'FitRec and gym opening hours', domain: 'places', kind: 'published', period: week, url: SOURCE_URLS.fitrec, coverage: `${n(published('gym'))} of ${n(kinds('gym').length)} gyms with published hours` },
    evidence: { name: 'Published place figures (meal counts, seats, beds)', domain: 'places', kind: 'published', period: null, url: null, coverage: plural(evidence, 'published figure') },
    classSchedule: { name: `BU ${data.term} class schedule`, domain: 'classes', kind: 'published', period: data.term, url: SOURCE_URLS.classSchedule, coverage: `${n(meetings)} class meetings in ${n(meetingBuildings)} mapped buildings` },
    walkRoutes: { name: 'OpenStreetMap pedestrian routes', domain: 'walking', kind: 'mixed', period: null, url: SOURCE_URLS.osm, coverage: plural(Object.keys(campus.walkRoutes).length, 'mapped route') },
    terrierCentral: { name: 'Terrier Central student-organization events', domain: 'events', kind: 'published', period: data.collectedAt?.slice(0, 10) ? `retrieved ${data.collectedAt.slice(0, 10)}` : null, url: SOURCE_URLS.terrierCentral, coverage: `${n(data.events.length)} events, ${n(mapped)} at mapped places` },
    eventImpact: { name: 'Event impact simulation (with and without events)', domain: 'events', kind: 'simulated', period: eiDates.length ? `${eiDates[0]} to ${eiDates.at(-1)}` : null, url: null, coverage: ei ? `${plural(eiDates.length, 'date')}, ${plural(gatherings, 'simulated event')}` : missing },
    venueCalendar: { name: 'Big-venue calendar (BU athletics, Agganis Arena, Fenway Park, MGM Music Hall)', domain: 'events', kind: 'published', period: chat?.venues ? `${chat.venues.window.from} to ${chat.venues.window.to}` : null, url: null, coverage: chat?.venues ? `${plural(chat.venues.events.length, 'event')} at ${plural(chat.venues.venues.length, 'venue')}` : missing },
    mbta: { name: 'MBTA scheduled service (GTFS)', domain: 'transit', kind: 'published', period: chat?.transit ? chat.transit.mbtaFeed : null, url: SOURCE_URLS.mbtaGtfs, coverage: chat?.transit ? `${plural(chat.transit.stops.filter((s) => s.kind !== 'shuttle').length, 'stop')}, ${plural(chat.transit.routes.filter((r) => r.operator === 'mbta').length, 'route')}` : missing },
    shuttle: { name: 'BU Shuttle schedule (2024–25 GTFS baseline with recorded current times)', domain: 'transit', kind: 'mixed', period: chat?.transit ? chat.transit.shuttleFeed : null, url: SOURCE_URLS.shuttleGtfs, coverage: chat?.transit ? `${plural(chat.transit.stops.filter((s) => s.kind === 'shuttle').length, 'stop')}, ${plural(chat.transit.routes.filter((r) => r.operator === 'bu-shuttle').length, 'route')}` : missing },
    bluebikes: { name: 'Bluebikes trip history at BU-area docks', domain: 'bikes', kind: 'published', period: chat?.bikes ? `${chat.bikes.weekday}s, ${chat.bikes.month}` : null, url: SOURCE_URLS.bluebikes, coverage: chat?.bikes ? `${plural(chat.bikes.docks.length, 'dock')}, typical-day profiles` : missing },
    parking: { name: 'Parking lots and garages', domain: 'parking', kind: 'mixed', period: null, url: SOURCE_URLS.parking, coverage: chat?.parking.length ? plural(chat.parking.length, 'lot') : missing },
    housing: { name: 'BU Housing residences and bed counts', domain: 'housing', kind: 'mixed', period: week, url: SOURCE_URLS.housing, coverage: `${plural(dorms.length, 'residence')}, ${n(dorms.reduce((a, l) => a + l.capacity, 0))} mapped beds` },
    cdsHousing: { name: 'BU Common Data Set 2025–26, housing (F1)', domain: 'housing', kind: 'published', period: pop ? pop.students.reportingPeriod : null, url: SOURCE_URLS.cdsHousing, coverage: pop ? `${pop.housing.degreeSeekingUndergraduateResidentPercent}% of degree-seeking undergraduates in BU housing` : missing },
    factSheet: { name: 'BU Facts fact sheet FY2026 (employees, campus FTE)', domain: 'population', kind: 'published', period: pop ? pop.employees.reportingPeriod : null, url: SOURCE_URLS.factSheet, coverage: pop ? `${n(pop.employees.total)} employees` : missing },
    fitrecCounts: { name: 'FitRec hourly entry counts', domain: 'counts', kind: 'published', period: fit ? `${fit.periodStart} to ${fit.periodEnd}` : null, url: SOURCE_URLS.fitrec, coverage: fit ? plural(fit.observations.length, 'hourly count') : missing },
    pedestrianCounts: { name: 'Commonwealth Avenue pedestrian counts (Warren Towers planning notice)', domain: 'counts', kind: 'published', period: f.pedestrians[0] ? `${f.pedestrians[0].observedFrom} to ${f.pedestrians[0].observedTo}` : null, url: SOURCE_URLS.warrenEpnf, coverage: plural(f.pedestrians.length, 'site') },
    libraryGateCounts: { name: 'School of Theology Library historical gate counts', domain: 'counts', kind: 'published', period: chat?.libraryHistory?.observationPeriod ?? null, url: SOURCE_URLS.libraryGateCounts, coverage: chat?.libraryHistory ? plural(chat.libraryHistory.patronCounts.length, 'time slot') : missing },
    calibration: { name: 'Calibration counts (MBTA ridership, crosswalk counts)', domain: 'counts', kind: 'published', period: null, url: chat?.validation?.observationSources.find((s) => s.url)?.url ?? null, coverage: chat?.validation ? `${plural(chat.validation.transitSeries, 'transit series', 'transit series')}, ${plural(chat.validation.pedestrianSeries, 'pedestrian series', 'pedestrian series')}` : missing },
    validationScores: { name: 'Simulated vs published comparison scores', domain: 'counts', kind: 'mixed', period: chat?.validation ? `computed ${chat.validation.generated}` : null, url: null, coverage: metrics.length ? `${plural(metrics.length, 'score')} on ${plural(new Set(metrics.map((m) => m.day)).size, 'day type')}` : missing },
    scenarios: { name: 'What-if scenario presets', domain: 'conditions', kind: 'assumption', period: null, url: null, coverage: chat?.scenarios.length ? plural(chat.scenarios.length, 'scenario') : missing },
    behaviour: { name: 'Behaviour assumptions for weather and the academic calendar', domain: 'conditions', kind: 'assumption', period: null, url: null, coverage: `${plural(conditionsMods, 'condition rule')}, ${plural(fittedMods, 'fitted calibration rule')}` },
    academicCalendar: { name: 'BU Registrar semester calendar', domain: 'calendar', kind: 'published', period: terms.length ? terms.map((t) => t.term).join(', ') : null, url: SOURCE_URLS.academicCalendar, coverage: terms.length ? plural(terms.length, 'term') : missing },
    fireNetwork: { name: 'Boston Fire Department firehouses on OpenStreetMap streets', domain: 'emergencies', kind: 'mixed', period: null, url: SOURCE_URLS.bfd, coverage: chat?.fire ? `${plural(chat.fire.stations.length, 'firehouse')}, ${n(chat.fire.stations.reduce((a, s) => a + s.units.length, 0))} companies` : missing },
    incidentModel: { name: 'Incident, evacuation and fire-response assumptions', domain: 'emergencies', kind: 'assumption', period: null, url: null, coverage: '6 incident kinds' },
  };
}

interface DomainSpec { id: string; title: string; description: string; datasets: DatasetId[]; examples: string[] }

const DOMAINS: DomainSpec[] = [
  { id: 'crowds', title: 'Crowds', description: 'How full each place is in the simulation at any minute of the reference week: simulated students over each place’s stated capacity, with the assumptions behind them.',
    datasets: ['simulation', 'capacityBasis', 'assumptions'], examples: ['Which library is least crowded right now?', 'How busy is GSU over the day?', 'Why is Mugar so full in the evening?'] },
  { id: 'places', title: 'Places, hours and dining', description: 'Published opening hours for dining halls, cafés, libraries and gyms, whether a place is open now, and published figures such as meals served a day.',
    datasets: ['diningHours', 'libraryHours', 'fitrecHours', 'evidence'], examples: ['Is Warren dining open now?', 'When does the Science & Engineering Library close?', 'How many meals does Marciano serve?'] },
  { id: 'classes', title: 'Classes and rooms', description: 'Where and when courses meet from the published class schedule, and rooms with no published class at a time.',
    datasets: ['classSchedule'], examples: ['Where does CAS CS 132 meet next?', 'Which rooms in CDS are free now?'] },
  { id: 'walking', title: 'Walking', description: 'Walking distance and time between places along mapped footpaths, at a stated walking speed.',
    datasets: ['walkRoutes'], examples: ['How long is the walk from CAS to Mugar?', 'How far is FitRec from Warren Towers?'] },
  { id: 'events', title: 'Events', description: 'Published campus events, how they change simulated crowding on a date, and big-venue games and concerts. Registrations are sign-ups, never attendance.',
    datasets: ['terrierCentral', 'eventImpact', 'venueCalendar'], examples: ['What events are on this week?', 'How do events change crowding on Oct 29?', 'Is there a hockey game at Agganis on Oct 31?'] },
  { id: 'transit', title: 'Transit', description: 'Scheduled MBTA Green Line and bus departures and BU Shuttle times from stops near a place. Scheduled service, not live arrivals.',
    datasets: ['mbta', 'shuttle'], examples: ['When is the next Green Line train near CAS?', 'Which buses stop near the medical campus?'] },
  { id: 'bikes', title: 'Bluebikes', description: 'Bluebikes docks near BU: dock counts and typical-day rides docked and undocked by hour, from the published trip history. No individual rides.',
    datasets: ['bluebikes'], examples: ['Where is the nearest Bluebikes dock to Mugar?', 'When are BU’s Bluebikes docks busiest?'] },
  { id: 'housing', title: 'Housing', description: 'Residence halls with their bed counts and each figure’s basis, the published share of undergraduates in BU housing, and published availability notes.',
    datasets: ['housing', 'cdsHousing'], examples: ['How many beds does Warren Towers have this week?', 'What share of undergraduates live on campus?'] },
  { id: 'population', title: 'Population', description: 'Published student and employee totals by level, attendance and campus. Aggregates only; nothing about any individual.',
    datasets: ['enrollment', 'factSheet'], examples: ['How many students does BU have?', 'How many graduate students study part-time?'] },
  { id: 'counts', title: 'Published counts and validation', description: 'Observed counts from their own periods (FitRec entries, pedestrian crossings, historical library gate counts, MBTA ridership) and how the simulation compares with them.',
    datasets: ['fitrecCounts', 'pedestrianCounts', 'libraryGateCounts', 'calibration', 'validationScores'], examples: ['When is FitRec busiest according to its own counts?', 'How does the simulation compare with real counts?', 'How many people cross Comm Ave at Granby Street at rush hour?'] },
  { id: 'conditions', title: 'Weather and what-if scenarios', description: 'How weather and the academic calendar change simulated behaviour, and the map’s what-if presets such as a snow day or a home hockey game. These are stated assumptions.',
    datasets: ['behaviour', 'scenarios'], examples: ['How does rain change campus behaviour?', 'What does the snow day scenario change?', 'What what-if scenarios can I try?'] },
  { id: 'calendar', title: 'Academic calendar', description: 'Whether classes are in session on a date, holidays, recesses, study period and final exams, from the Registrar’s published calendar.',
    datasets: ['academicCalendar'], examples: ['Are there classes on November 11?', 'When do final exams start?'] },
  { id: 'emergencies', title: 'Emergencies', description: 'The map’s incident what-ifs (drill, alarm, closure, fire, earthquake, meteor) and the modeled Boston Fire Department first-alarm response to a building. Uncalibrated assumptions.',
    datasets: ['incidentModel', 'fireNetwork'], examples: ['Which fire companies would respond to a fire alarm at CDS?', 'What emergency scenarios can the map run?'] },
  { id: 'parking', title: 'Parking', description: 'Parking lots and garages near BU with their spaces and the basis of that figure. How full they are is not observed.',
    datasets: ['parking'], examples: ['Where can I park near Agganis Arena?', 'Which BU garages have the most spaces?'] },
];

export function buildDirectory(campus: CampusModel): DataDomain[] {
  const catalog = datasetCatalog(campus);
  return DOMAINS.map((d) => ({
    id: d.id, title: d.title, description: d.description, examples: d.examples,
    datasets: d.datasets.map((id) => {
      const { name, kind, period, url, coverage } = catalog[id];
      return { name, kind, period, url, coverage };
    }),
  }));
}

/** Which datasets each tool reads. published_counts and emergency_info depend on their output. */
const TOOL_DATASETS: Record<string, DatasetId[]> = {
  rank_places_by_crowd: ['simulation', 'capacityBasis'],
  place_day: ['simulation', 'capacityBasis', 'diningHours'],
  place_info: ['capacityBasis', 'evidence'],
  campus_overview: ['simulation', 'enrollment'],
  list_events: ['terrierCentral'],
  free_rooms: ['classSchedule'],
  find_course: ['classSchedule'],
  walking_route: ['walkRoutes'],
  model_basis: ['assumptions'],
  find_places: [],
  event_impact: ['eventImpact', 'terrierCentral'],
  bluebikes: ['bluebikes'],
  transit_near: ['mbta'],
  housing: ['housing', 'cdsHousing'],
  population_summary: ['enrollment', 'factSheet'],
  model_validation: ['validationScores', 'calibration'],
  what_if_scenarios: ['scenarios', 'behaviour'],
  weather_effects: ['behaviour'],
  emergency_info: ['incidentModel'],
  academic_calendar: ['academicCalendar'],
  parking_lots: ['parking'],
  library_gate_counts: ['libraryGateCounts'],
};

/** Hours datasets by the kind of place a tool output names. */
function hoursFor(kind: string | undefined): DatasetId {
  return kind === 'library' ? 'libraryHours' : kind === 'gym' ? 'fitrecHours' : 'diningHours';
}

/** The datasets one tool result drew on (none for errors and days still being simulated). */
export function datasetsForResult(tool: string, value: Record<string, any>, kindOf: (name: string) => string | undefined): DatasetId[] {
  if ('error' in value || 'available' in value) return [];
  if (tool === 'published_counts') return [String(value.source).startsWith('FitRec') ? 'fitrecCounts' : 'pedestrianCounts'];
  if (tool === 'emergency_info') return value.firstAlarm ? ['fireNetwork', 'incidentModel', ...(value.simulatedStudentsInside ? ['simulation' as const] : [])] : ['incidentModel'];
  if (tool === 'transit_near') return /Shuttle/.test(String(value.timetables)) ? ['mbta', 'shuttle'] : ['mbta'];
  if (tool === 'event_impact') return ['eventImpact', 'terrierCentral', ...(value.venueEvents?.length ? ['venueCalendar' as const] : [])];
  if (tool === 'place_day' || tool === 'place_info') {
    const base = (TOOL_DATASETS[tool] ?? []).filter((d) => d !== 'diningHours');
    const kind = kindOf(String(value.place ?? ''));
    return kind === 'classroom' || kind === 'dorm' ? base : [...base, hoursFor(kind)];
  }
  if (tool === 'housing' && value.residence?.simulatedStudentsThere) return [...TOOL_DATASETS.housing, 'simulation'];
  return TOOL_DATASETS[tool] ?? [];
}

/** De-duplicated citations for a run's tool results, in the order first used. */
export function citationsFor(results: { tool: string; value: object }[], catalog: Record<DatasetId, Dataset>, kindOf: (name: string) => string | undefined): Citation[] {
  const seen = new Set<DatasetId>();
  const out: Citation[] = [];
  for (const r of results) {
    for (const id of datasetsForResult(r.tool, r.value as Record<string, any>, kindOf)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const d = catalog[id];
      out.push({ label: d.name, domain: d.domain, kind: d.kind, url: d.url });
    }
  }
  return out;
}
