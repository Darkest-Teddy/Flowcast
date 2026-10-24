export interface RoadProfile {
  weekday: number;
  hour: number;
  direction: string;
  bikes: number;
  motorVehicles: number;
  samples: number;
}
export interface CountLocation<P> {
  id: string;
  name: string;
  position: [number, number];
  campus: string;
  observedFrom: string;
  observedTo: string;
  profiles: P[];
  sourceUrl?: string;
}
export interface PedestrianProfile {
  weekday: number | null;
  weekdays?: number[];
  hour: number;
  pedestrians: number;
  samples: number;
}
export interface BikeStation {
  id: string;
  name: string;
  position: [number, number];
  campus: string;
}
export interface BikeFlow {
  from: string;
  to: string;
  weekday: number;
  hour: number;
  trips: number;
  days: number;
  meanDurationSec: number;
}
export interface MobilityData {
  schemaVersion: 1;
  generatedAt: string;
  roads: { sourceUrl: string; locations: CountLocation<RoadProfile>[] };
  pedestrians: { sourceUrl: string; locations: CountLocation<PedestrianProfile>[] };
  bluebikes: { sourceUrl: string; period: { start: string; end: string }; stations: BikeStation[]; flows: BikeFlow[] };
}
export type MobilityMode = 'roads' | 'bikes' | 'pedestrians' | 'off';
export interface MobilityPoint {
  mobilityKind: 'road' | 'pedestrian' | 'station';
  id: string;
  name: string;
  position: [number, number];
  value: number;
  bikes?: number;
  samples: number;
  period: string;
  sourceUrl: string;
  details: string;
}
export interface MobilityArc {
  mobilityKind: 'flow';
  id: string;
  name: string;
  from: [number, number];
  to: [number, number];
  value: number;
  trips: number;
  days: number;
  duration: number;
  period: string;
  sourceUrl: string;
}
export interface MobilityView {
  mode: MobilityMode;
  hour: number;
  points: MobilityPoint[];
  arcs: MobilityArc[];
}
export const countText = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 1 });

/** Keep measured day/hour bins intact. A missing survey is not a zero count. */
export function mobilityAt(data: MobilityData, mode: MobilityMode, campus: string, weekday: number, time: number): MobilityView {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6 || !Number.isFinite(time) || time < 0 || time >= 86400) {
    return { mode, hour: 0, points: [], arcs: [] };
  }
  const hour = Math.floor(time / 3600);
  const view: MobilityView = { mode, hour, points: [], arcs: [] };
  if (mode === 'roads') {
    for (const site of data.roads.locations.filter((site) => site.campus === campus)) {
      const profiles = site.profiles.filter((p) => p.weekday === weekday && p.hour === hour);
      if (!profiles.length) continue;
      view.points.push({ mobilityKind: 'road', id: site.id, name: site.name, position: site.position,
        value: profiles.reduce((sum, p) => sum + p.motorVehicles, 0), bikes: profiles.reduce((sum, p) => sum + p.bikes, 0),
        samples: profiles.reduce((sum, p) => sum + p.samples, 0), period: `${site.observedFrom} to ${site.observedTo}`, sourceUrl: site.sourceUrl ?? data.roads.sourceUrl,
        details: profiles.map((p) => `${p.direction}: ${countText(p.motorVehicles)} vehicles/h, ${countText(p.bikes)} bikes/h (${p.samples} samples)`).join('\n') });
    }
  } else if (mode === 'pedestrians') {
    for (const site of data.pedestrians.locations.filter((site) => site.campus === campus)) {
      const exact = site.profiles.filter((p) => p.weekday === weekday && p.hour === hour);
      const profiles = exact.length ? exact : site.profiles.filter((p) => p.weekday === null && p.weekdays?.includes(weekday) && p.hour === hour);
      if (!profiles.length) continue;
      const samples = profiles.reduce((sum, p) => sum + p.samples, 0);
      if (!samples) continue;
      view.points.push({ mobilityKind: 'pedestrian', id: site.id, name: site.name, position: site.position,
        value: profiles.reduce((sum, p) => sum + p.pedestrians * p.samples, 0) / samples,
        samples, period: `${site.observedFrom} to ${site.observedTo}`, sourceUrl: site.sourceUrl ?? data.pedestrians.sourceUrl,
        details: exact.length ? 'Hourly crossing count' : 'Midweek survey · collection day is not separated in the source' });
    }
  } else if (mode === 'bikes') {
    const stations = new Map(data.bluebikes.stations.map((station) => [station.id, station]));
    const totals = new Map<string, number>();
    for (const flow of data.bluebikes.flows) {
      if (flow.weekday !== weekday || flow.hour !== hour || flow.days <= 0) continue;
      const from = stations.get(flow.from), to = stations.get(flow.to);
      if (!from || !to || (from.campus !== campus && to.campus !== campus)) continue;
      const value = flow.trips / flow.days;
      view.arcs.push({ mobilityKind: 'flow', id: `${flow.from}>${flow.to}`, name: `${from.name} → ${to.name}`,
        from: from.position, to: to.position, value, trips: flow.trips, days: flow.days,
        duration: flow.meanDurationSec, period: `${data.bluebikes.period.start} to ${data.bluebikes.period.end}`, sourceUrl: data.bluebikes.sourceUrl });
      totals.set(from.id, (totals.get(from.id) ?? 0) + value);
    }
    view.arcs.sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
    for (const [id, value] of totals) {
      const station = stations.get(id)!;
      view.points.push({ mobilityKind: 'station', id, name: station.name, position: station.position, value,
        samples: 0, period: `${data.bluebikes.period.start} to ${data.bluebikes.period.end}`, sourceUrl: data.bluebikes.sourceUrl,
        details: 'Departures to stations in the campus study areas' });
    }
  }
  view.points.sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
  return view;
}

export async function loadMobility(url = '/data/mobility.json'): Promise<MobilityData> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Traffic data unavailable (${response.status})`);
  const data = await response.json();
  if (data.schemaVersion !== 1 || !Array.isArray(data.roads?.locations) || !Array.isArray(data.pedestrians?.locations)
    || !Array.isArray(data.bluebikes?.flows) || !Array.isArray(data.bluebikes?.stations)) throw new Error('Unsupported traffic snapshot');
  return data;
}
