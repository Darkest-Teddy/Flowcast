import type { Layer } from '@deck.gl/core';
import { PolygonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { BuildingFootprint, CampusLocation, Occupancy } from '../sim/playback';
import { isDisasterKind, type DisasterKind, type Incident, type IncidentHazard } from '../sim/incidents';
import { damageAt, type BuildingDamageFrame } from '../sim/disasterDamage';
import { labelWidth, type LabelPlacer } from './placement';
import { DISASTER_COLORS, METEOR_APPROACH_SECONDS, ON_SURFACE, clamp01, disasterLayers } from './disasterEffects';
import { destructionLayers, isDamaged } from './destruction';
import { casualtyLayers } from './casualties';
import { casualtiesAt } from '../sim/incidentProgress';
import type { CasualtyEvent } from '../sim/casualties';

interface IncidentMapState {
  incident: Incident;
  /** Set for fire, earthquake and meteor scenarios (IncidentResult['hazard']). */
  hazard?: IncidentHazard | null;
  location: CampusLocation;
  assemblyLocation: CampusLocation | null;
  endsAt: number;
  /** Disaster casualty events (IncidentResult.casualties), sorted by time; only those at or before `time` are drawn. */
  casualties?: readonly CasualtyEvent[];
}

interface Outline { footprint: BuildingFootprint; color: [number, number, number, number]; width: number }

/**
 * The marker represents an aggregate count, not a measured assembly-area boundary.
 * `damage` is the frame's damageAt(run, time, footprints) result; when omitted it is computed here.
 * Active effects end at hazard.activeUntil; rubble, crater, outlines and the damage label stay until
 * the caller clears the run (reset or day change).
 */
export function incidentLayers(run: IncidentMapState | null, time: number, occupancy: Occupancy[], footprints: BuildingFootprint[],
  placer: LabelPlacer, damage?: readonly BuildingDamageFrame[]) {
  if (!run) return [];
  const kind: string = run.incident.kind;
  const disaster = isDisasterKind(kind) && run.hazard ? kind : null;
  const hazard = disaster ? run.hazard! : null;
  const start = run.incident.start;
  const lead = disaster === 'meteor' ? METEOR_APPROACH_SECONDS : 0;
  if (time < start - lead) return [];
  const center = run.location.position;
  const primary = run.location.building;

  // Only the meteor's approach is drawn before the incident starts.
  if (time < start) return hazard ? disasterLayers({ kind: disaster!, hazard, center, baseHeight: 10, start, time, damage: [] }) : [];

  const closed = time < run.endsAt;
  const hazardActive = !!hazard && time < hazard.activeUntil;
  const frames = hazard ? damage ?? damageAt(run, time, footprints) : [];
  const damaged = new Set(frames.filter(isDamaged).map(d => d.id));

  // Primary building keeps the original yellow; other hazard-affected buildings use the kind's accent,
  // and after the hazard ends only the damaged ones stay outlined.
  const outlines: Outline[] = [];
  if (closed || hazardActive || damaged.size) {
    const affected = new Set(hazardActive ? hazard!.affectedBuildingIds : []);
    const accent = disaster ? DISASTER_COLORS[disaster] : null;
    for (const footprint of footprints) {
      if (footprint.id === primary) { if (closed || hazardActive) outlines.push({ footprint, color: [255, 214, 10, 255], width: 3 }); }
      else if (accent && affected.has(footprint.id)) outlines.push({ footprint, color: [...accent, 230], width: 2 });
      else if (accent && damaged.has(footprint.id)) outlines.push({ footprint, color: [...accent, 170], width: 2 });
    }
  }
  const outline = new PolygonLayer<Outline>({
    id: 'incident-building-outline',
    data: outlines,
    getPolygon: item => item.footprint.polygon,
    filled: false,
    stroked: true,
    getLineColor: item => item.color,
    getLineWidth: item => item.width,
    lineWidthUnits: 'pixels',
    lineWidthMinPixels: 2,
    pickable: false,
    parameters: ON_SURFACE,
  });
  const layers: Layer[] = [outline];

  // The assembly label is placed before the hazard label, so it wins any overlap.
  const assembly = run.assemblyLocation;
  if (assembly && kind !== 'building-closure') {
    const count = occupancy.find(entry => entry.location.id === assembly.id)?.count ?? 0;
    if (closed || count > 0) layers.push(...assemblyLayers(assembly, count, placer));
  }

  if (hazard) {
    const footprint = footprints.find(f => f.id === primary);
    const effects = hazardActive ? disasterLayers({ kind: disaster!, hazard, center, baseHeight: footprint?.height || 10,
      footprint: footprint?.polygon ?? null, start, time, damage: frames }) : [];
    layers.unshift(...destructionLayers({ kind: disaster!, hazard, center, start, time, damage: frames }), ...effects);
    // Aggregate injured markers only; fatalities stay in the panel.
    layers.push(...casualtyLayers(run.casualties, time));
    const injured = casualtiesAt(run, time).filter(event => event.outcome === 'injured').length;
    const label = hazardLabel(disaster!, hazard, time, damaged.size, injured);
    if (label) layers.push(...labelLayers(disaster!, center, label.text, label.opacity, placer));
  }
  return outlines.length || layers.length > 1 ? layers : [];
}

function hazardLabel(kind: DisasterKind, hazard: IncidentHazard, time: number, damagedCount: number, injured = 0): { text: string; opacity: number } | null {
  const radius = hazard.radiusMetres > 0 ? ` · ${Math.round(hazard.radiusMetres)} m` : '';
  const hurt = injured ? ` · ${injured.toLocaleString()} modeled injured` : '';
  const buildings = (damagedCount ? ` · ${damagedCount} building${damagedCount === 1 ? '' : 's'} damaged` : '') + hurt;
  if (time >= hazard.activeUntil) {
    if (kind === 'meteor') return { text: `Modeled impact crater${buildings}`, opacity: 0.9 };
    return damagedCount || injured ? { text: `Modeled ${kind === 'fire' ? 'fire' : 'earthquake'} damage${buildings}`, opacity: 0.9 } : null;
  }
  const fade = 0.35 + 0.65 * clamp01((hazard.activeUntil - time) / 60);
  if (kind === 'fire') return { text: `Modeled fire${radius}${hurt}`, opacity: fade };
  if (kind === 'earthquake') return { text: `Modeled earthquake · ${time < hazard.responseStartsAt ? 'shaking' : 'closure area'}${radius}${hurt}`, opacity: fade };
  return { text: `Modeled meteor impact${radius}${hurt}`, opacity: fade };
}

function labelLayers(kind: DisasterKind, center: [number, number], label: string, opacity: number, placer: LabelPlacer): Layer[] {
  const [r, g, b] = DISASTER_COLORS[kind];
  const anchor = { position: center };
  const lifts = placer.place([anchor], { position: () => center, width: () => labelWidth(label, 13), height: 26, gap: 10, direction: 1 });
  const lift = lifts.get(anchor);
  if (lift === undefined) return [];
  return [new TextLayer({
    id: `incident-${kind}-label`,
    data: [anchor],
    getPosition: () => [center[0], center[1], 1],
    getText: () => label,
    getSize: 13,
    getPixelOffset: [0, 10 + 13 + lift * 26],
    getColor: [255, 255, 255, Math.round(255 * opacity)],
    background: true,
    getBackgroundColor: [17, 20, 28, Math.round(225 * opacity)],
    getBorderColor: [r, g, b, Math.round(255 * opacity)],
    getBorderWidth: 1,
    backgroundPadding: [7, 4],
    billboard: true,
    pickable: false,
    characterSet: 'auto',
    parameters: { depthCompare: 'always' },
    updateTriggers: { getText: label, getColor: opacity, getBackgroundColor: opacity, getBorderColor: opacity, getPixelOffset: lift },
    slot: 'top',
  })];
}

function assemblyLayers(assembly: CampusLocation, count: number, placer: LabelPlacer): Layer[] {
  const point = { position: [...assembly.position, 1] as [number, number, number], count };
  const label = `Assembly · ${count.toLocaleString()} outdoors`;
  placer.place([point], { position: () => assembly.position,
    width: () => labelWidth(label, 14), height: 28, gap: 8, direction: -1 });
  return [
    new ScatterplotLayer({
      id: 'incident-assembly-marker',
      data: [point],
      getPosition: item => item.position,
      getRadius: 5,
      radiusMinPixels: 6,
      radiusMaxPixels: 12,
      stroked: true,
      getFillColor: [255, 214, 10, 200],
      getLineColor: [255, 255, 255, 255],
      lineWidthMinPixels: 2,
      pickable: false,
      parameters: { depthCompare: 'always' },
      slot: 'top',
    }),
    new TextLayer({
      id: 'incident-assembly-label',
      data: [point],
      getPosition: item => item.position,
      getText: () => label,
      getSize: 14,
      getPixelOffset: [0, -22],
      getColor: [255, 255, 255, 255],
      background: true,
      getBackgroundColor: [17, 20, 28, 235],
      backgroundPadding: [8, 5],
      billboard: true,
      pickable: false,
      characterSet: 'auto',
      parameters: { depthCompare: 'always' },
      updateTriggers: { getText: label },
      slot: 'top',
    }),
  ];
}
