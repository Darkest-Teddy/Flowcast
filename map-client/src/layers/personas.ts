// Customizable personas, rendered as real composed 3D geometry (see sim/personaParts.ts for the
// part catalog and personaMeshes.ts for how each part becomes a luma.gl mesh), GPU-instanced with
// deck.gl's SimpleMeshLayer. One SimpleMeshLayer per (category, option, color-layer) that actually
// appears among the joined personas -- bounded by the catalog size (a few dozen at most), never by
// how many students join, so the draw-call count stays fixed no matter how many personas are on
// the map. A costumed persona's regular-outfit layers are skipped entirely; it only appears in its
// costume's own layers.
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { zoomGrowth } from './agents';
import { meshForLayer } from './personaMeshes';
import { resolveLayers, type PartCategory, type PersonaAppearance, type PartLayer } from '../sim/personaParts';
import type { PersonaAgent } from '../sim/persona';

type Vec3 = [number, number, number];

const YAW_OFFSET = 180; // matches agents.ts: a compass bearing -> deck.gl yaw convention

function colorOf([r, g, b]: readonly [number, number, number], alpha = 255): [number, number, number, number] {
  return [r, g, b, alpha];
}

function phaseOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return (Math.abs(h) % 1000) / 1000;
}

/** A tiny vertical bob while walking, a slow sway while idle -- per-instance position/orientation
 *  math only, no skeletal animation, no extra draw calls. Phase-offset per persona so a cluster
 *  never bobs in lockstep. */
function animatedPosition(d: PersonaAgent, time: number): Vec3 {
  if (d.clip !== 'walk') return d.position;
  const phase = phaseOf(d.persona.id);
  const bob = Math.abs(Math.sin(time * 2.2 + phase * Math.PI * 2)) * 0.035;
  return [d.position[0], d.position[1], (d.position[2] ?? 0) + bob];
}
function animatedOrientation(d: PersonaAgent, time: number): Vec3 {
  const yaw = YAW_OFFSET - d.bearing;
  if (d.clip !== 'idle') return [0, yaw, 90];
  const phase = phaseOf(d.persona.id);
  const sway = Math.sin(time * 1.1 + phase * Math.PI * 2) * 4;
  return [sway, yaw, 90];
}

export interface PersonaLayerOptions {
  zoom: number;
  time: number;
  highlightId?: string | null;
}

/** Every (category, optionId, layerIndex) bucket present among these agents, each with the list of
 * agents wearing it. The bucket set only ever grows to catalog size, never to agent count. */
function bucketAgents(agents: PersonaAgent[]) {
  const buckets = new Map<string, { layer: PartLayer; agents: PersonaAgent[] }>();
  for (const agent of agents) {
    for (const { category, optionId, layerIndex, layer } of resolveLayers(agent.persona.appearance)) {
      const key = `${category}:${optionId}:${layerIndex}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { layer, agents: [] };
        buckets.set(key, bucket);
      }
      bucket.agents.push(agent);
    }
  }
  return buckets;
}

export function personaLayers(agents: PersonaAgent[], options: PersonaLayerOptions) {
  const { zoom, time, highlightId = null } = options;
  const sizeScale = zoomGrowth(zoom);
  const buckets = bucketAgents(agents);

  const common = {
    sizeScale,
    sizeMinPixels: 22,
    getPosition: (d: PersonaAgent) => animatedPosition(d, time),
    getOrientation: (d: PersonaAgent) => animatedOrientation(d, time),
    updateTriggers: { getPosition: time, getOrientation: time, getColor: [highlightId] },
    _lighting: 'pbr' as const,
    pickable: true,
    slot: 'middle', // read by @deck.gl/mapbox to place the layer in Mapbox Standard (not a typed prop)
  };

  return [...buckets.entries()].map(([key, bucket]) => {
    const base = colorOf(bucket.layer.color);
    return new SimpleMeshLayer<PersonaAgent>({
      id: `persona-${key}`,
      data: bucket.agents,
      mesh: meshForLayer(key, bucket.layer),
      getColor: (d) => (d.persona.id === highlightId ? [255, 214, 10, 255] : base),
      ...common,
    });
  });
}

export type { PartCategory, PersonaAppearance };
