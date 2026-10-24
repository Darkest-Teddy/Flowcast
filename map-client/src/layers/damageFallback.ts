import { PolygonLayer } from '@deck.gl/layers';
import type { BuildingDamageFrame } from '../sim/disasterDamage';
import type { BuildingModelManifest } from './buildings';

/** Enclose stacked volumes as well as ground footprints when hiding duplicate city extrusions. */
export function damageExclusionAreas(damage: readonly BuildingDamageFrame[], manifest?: BuildingModelManifest) {
  return damage.map(building => {
    const model = manifest?.campuses.flatMap(campus => campus.buildings).find(entry => entry.osm === building.id);
    const points = [...building.rings.flat(), ...(model?.volumes?.flatMap(volume => volume.ring) ?? [])];
    const latPad = 2 / 111320, lngPad = latPad / Math.cos(building.center[1] * Math.PI / 180);
    const west = Math.min(...points.map(point => point[0])) - lngPad;
    const east = Math.max(...points.map(point => point[0])) + lngPad;
    const south = Math.min(...points.map(point => point[1])) - latPad;
    const north = Math.max(...points.map(point => point[1])) + latPad;
    return [[west, south], [east, south], [east, north], [west, north]] as [number, number][];
  });
}

/** Replace excluded city boxes when a damaged building has no loaded detailed model. */
export function fallbackDamageLayers(damage: readonly BuildingDamageFrame[], modeled: ReadonlySet<string>) {
  const parts = damage.filter(building => !modeled.has(building.id)).flatMap(building =>
    building.rings.map(polygon => ({ building, polygon })));
  if (!parts.length) return [];
  return [new PolygonLayer({
    id: 'incident-damage-fallback',
    data: parts,
    getPolygon: part => part.polygon,
    extruded: true,
    getElevation: part => Math.max(0.3, part.building.remainingHeight),
    getFillColor: part => {
      const shade = Math.round(190 - 150 * part.building.scorch);
      return [shade, Math.round(shade * 0.95), Math.round(shade * 0.9), 255];
    },
    stroked: false,
    pickable: false,
    slot: 'middle',
  })];
}
