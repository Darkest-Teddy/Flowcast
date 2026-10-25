// Students, and the public riders the MBTA counts add (sim/publicCrowd.ts), waiting at a stop for
// their published departure, drawn as idle characters.
//
// Each waiting student stands beside the track their vehicle will use: on the right of travel
// along a Green Line platform, or at the kerb of a bus stop. Spots are stable per student, so the
// crowd doesn't shuffle from frame to frame.
import { characterLayers, type LoadedModels } from './agents';
import type { WaitingRider, WalkingAgent } from '../sim/playback';
import { pointAlong, snapToTracks, type Track } from '../transit/tracks';

const METRES_PER_DEG_LAT = 110_540;
const SHAPE = {
  subway: { near: 2.5, far: 4.6, half: 18 }, // a two-car train's length of platform
  bus: { near: 0.3, far: 1.9, half: 3.5 }, // beyond the kerb
};

interface Platform { centre: [number, number]; along: [number, number]; side: [number, number]; kerb: number; kind: 'subway' | 'bus' }
const platforms = new Map<string, Platform | null>();

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

function platformFor(rider: WaitingRider, tracks: Track[]): Platform | null {
  const key = `${rider.stop}|${rider.route}|${rider.direction}`;
  if (platforms.has(key)) return platforms.get(key)!;
  // Ridership counted for the Green Line as a whole stands at whichever branch's platform is there.
  const own = tracks.filter((t) => (rider.route === 'Green' ? t.route.startsWith('Green-') : t.route === rider.route) && t.direction === rider.direction);
  const hit = snapToTracks(own, rider.position);
  let platform: Platform | null = null;
  if (hit && hit.distance <= 40) {
    const { position, bearing } = pointAlong(hit.track, hit.s);
    const rad = (bearing * Math.PI) / 180;
    const along: [number, number] = [Math.sin(rad), Math.cos(rad)]; // east, north
    const right: [number, number] = [along[1], -along[0]];
    const kx = METRES_PER_DEG_LAT * Math.cos((position[1] * Math.PI) / 180);
    const dx = (rider.position[0] - position[0]) * kx, dy = (rider.position[1] - position[1]) * METRES_PER_DEG_LAT;
    const subway = rider.route.startsWith('Green');
    // Trains: right of travel. Buses: whichever side of the road the stop is on.
    const sign = subway || dx * right[0] + dy * right[1] >= -1 ? 1 : -1;
    platform = { centre: position, along, side: [right[0] * sign, right[1] * sign], kind: subway ? 'subway' : 'bus',
      kerb: subway ? 0 : Math.min(7, Math.max(2, hit.distance)) };
  }
  platforms.set(key, platform);
  return platform;
}

/** Where each waiting student stands, facing the track. Riders whose stop isn't on a track keep the stop's point. */
export function waitingCharacters(waiting: WaitingRider[], tracks: Track[]): WalkingAgent[] {
  return waiting.map((rider) => {
    const platform = platformFor(rider, tracks);
    if (!platform) return { id: rider.id, model: rider.model, position: [rider.position[0], rider.position[1], 0], bearing: 0, to: rider.stop };
    const shape = SHAPE[platform.kind];
    const along = (hash(`${rider.id}:along`) * 2 - 1) * shape.half;
    const out = platform.kerb + shape.near + hash(`${rider.id}:out`) * (shape.far - shape.near);
    const kx = METRES_PER_DEG_LAT * Math.cos((platform.centre[1] * Math.PI) / 180);
    const east = platform.along[0] * along + platform.side[0] * out;
    const north = platform.along[1] * along + platform.side[1] * out;
    // Face the track, give or take a little.
    const facing = (Math.atan2(-platform.side[0], -platform.side[1]) * 180) / Math.PI + (hash(`${rider.id}:turn`) - 0.5) * 50;
    return {
      id: rider.id,
      model: rider.model,
      position: [platform.centre[0] + east / kx, platform.centre[1] + north / METRES_PER_DEG_LAT, 0],
      bearing: (facing + 360) % 360,
      to: rider.stop,
    };
  });
}

export function waitingRiderLayers(people: WalkingAgent[], models: LoadedModels, time: number, zoom: number) {
  return characterLayers(people, models, time, { id: 'transit-waiting', zoom, clip: 'idle', pickable: true });
}
