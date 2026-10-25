// Meteor fatalities as ragdolls: when the impact front reaches someone the casualty model marks as
// killed (sim/casualties.ts), they are thrown away from the impact, tumbling, and come down to lie
// still where they land for the rest of the day. Their walks already stop at that moment (playback
// clips them), so the ragdoll takes over from the walker. Purely illustrative, like the damage; the
// flight is a pure function of sim time, so it replays the same after a scrub and at any speed.
import { ScenegraphLayer } from '@deck.gl/mesh-layers';
import type { Layer } from '@deck.gl/core';
import type { CasualtyEvent } from '../sim/casualties';
import { boxAround, setCullBox } from './culling';
import { stableList } from './stable';
import { walkerScale, type LoadedModels } from './agents';

/** Most ragdolls drawn at once, nearest the impact first. */
const MAX_RAGDOLLS = 400;
/** Flight time, sim seconds (the impact front itself takes 3: disasterDamage.ts). */
const FLIGHT_SECONDS: [number, number] = [2.4, 4.8];
/** Peak height and throw distance at the impact; both shrink toward the edge of the radius. */
const APEX_METRES: [number, number] = [14, 48];
const THROW_METRES: [number, number] = [18, 60];
// Kenney models face +Z in glTF space; standing them up takes a 90° roll (see agents.ts), and with no
// roll they lie flat on their back. Yaw turns a compass bearing into deck.gl yaw, as for walkers.
const YAW_OFFSET = 180;

export interface RagdollPose {
  id: string;
  model: number;
  /** [lng, lat, metres above ground]. */
  position: [number, number, number];
  /** deck.gl [pitch, yaw, roll], degrees. */
  orientation: [number, number, number];
  landed: boolean;
}

function hash01(key: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
const lerp = ([a, b]: [number, number], f: number) => a + (b - a) * f;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Where each meteor fatality is at `time`: in flight, or lying where they landed. */
export function ragdollsAt(events: readonly CasualtyEvent[], impact: [number, number], radiusMetres: number,
  time: number, modelOf: (id: string) => number): RagdollPose[] {
  const kx = 111_320 * Math.cos((impact[1] * Math.PI) / 180), ky = 111_320;
  const out: RagdollPose[] = [];
  for (const event of events) {
    if (event.cause !== 'meteor' || event.outcome !== 'fatality' || event.at > time) continue;
    const id = event.agentId;
    const dx = (event.position[0] - impact[0]) * kx, dy = (event.position[1] - impact[1]) * ky;
    const distance = Math.hypot(dx, dy);
    // Away from the impact; someone at ground zero goes a random way.
    const angle = distance > 1 ? Math.atan2(dy, dx) : hash01(id, 1) * 2 * Math.PI;
    const strength = 1 - 0.6 * clamp01(distance / Math.max(1, radiusMetres));
    const flight = lerp(FLIGHT_SECONDS, hash01(id, 2));
    const apex = lerp(APEX_METRES, hash01(id, 3)) * strength;
    const reach = lerp(THROW_METRES, hash01(id, 4)) * strength;
    const f = clamp01((time - event.at) / flight);
    const along = reach * (1 - (1 - f) ** 1.6); // fast off the ground, slowing as it falls
    const x = event.position[0] + (Math.cos(angle) * along) / kx;
    const y = event.position[1] + (Math.sin(angle) * along) / ky;
    const z = 4 * apex * f * (1 - f);
    // Tumble end over end and side over side, finishing flat on the back (roll 0 mod 360).
    const flips = 1 + Math.floor(hash01(id, 5) * 2), rolls = Math.floor(hash01(id, 6) * 2);
    const pitch = 360 * flips * f;
    const roll = 90 * (1 - f) + 360 * rolls * f;
    const bearing = 90 - (angle * 180) / Math.PI; // compass, clockwise from north
    out.push({ id, model: modelOf(id), position: [x, y, z], orientation: [pitch % 360, YAW_OFFSET - bearing + lerp([-40, 40], hash01(id, 7)), roll % 360], landed: f >= 1 });
  }
  if (out.length > MAX_RAGDOLLS) {
    const near = (p: RagdollPose) => Math.hypot((p.position[0] - impact[0]) * kx, (p.position[1] - impact[1]) * ky);
    out.sort((a, b) => near(a) - near(b));
    out.length = MAX_RAGDOLLS;
  }
  return out;
}

// Frozen: no clip plays, so a body lies still in the rest pose.
const STILL = { '*': { playing: false } };

/** The ragdolls as character models, one layer per model. */
export function ragdollLayers(poses: RagdollPose[], models: LoadedModels, time: number, zoom: number): Layer[] {
  if (!poses.length) return [];
  const sizeScale = walkerScale(zoom);
  const flying = poses.some((pose) => !pose.landed);
  const buckets: RagdollPose[][] = [];
  for (const pose of poses) (buckets[pose.model % models.length] ??= []).push(pose);
  const layers: Layer[] = [];
  buckets.forEach((bucket, model) => {
    if (!bucket?.length) return;
    const id = `incident-ragdolls-${model}`;
    const data = stableList(id, bucket, (pose) => pose.id);
    setCullBox(id, boxAround(data.map((pose) => pose.position), sizeScale, sizeScale + Math.max(...data.map((pose) => pose.position[2]))));
    layers.push(new ScenegraphLayer<RagdollPose>({
      id,
      data,
      scenegraph: models[model] as never,
      _animations: STILL,
      _lighting: 'pbr',
      sizeScale,
      sizeMinPixels: 22,
      getPosition: (pose) => pose.position,
      getOrientation: (pose) => pose.orientation,
      // Only while someone is in the air do positions change frame to frame.
      updateTriggers: { getPosition: flying ? time : 'landed', getOrientation: flying ? time : 'landed' },
      pickable: false,
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }));
  });
  return layers;
}
