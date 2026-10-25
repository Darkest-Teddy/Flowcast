// Evacuees of a building fire standing outside (sim/fireCrowd.ts), drawn as idle characters at their
// own spots, facing the building. They share the waiting riders' idle layers (layers/waitingRiders.ts),
// so a fire adds no layers; with no fire nothing is drawn.
import type { WalkingAgent } from '../sim/playback';
import type { FireCrowd } from '../sim/fireCrowd';

const NONE: WalkingAgent[] = [];
// One object per person per fire: stable identities and positions, so the idle layers re-upload nothing while the crowd stands.
const people = new WeakMap<FireCrowd, Map<string, WalkingAgent>>();

/** People standing in the fire's crowd areas at this time (from Playback.outdoorAt), placed at their spots. */
export function crowdCharacters(outdoor: WalkingAgent[], crowd: FireCrowd | null | undefined): WalkingAgent[] {
  if (!crowd || !outdoor.length) return NONE;
  let known = people.get(crowd);
  if (!known) people.set(crowd, (known = new Map()));
  const out: WalkingAgent[] = [];
  for (const person of outdoor) {
    const spot = crowd.spots[person.id];
    if (!spot || spot.area !== person.to) continue;
    let agent = known.get(person.id);
    if (!agent) known.set(person.id, (agent = { id: person.id, model: person.model, position: [spot.position[0], spot.position[1], 0], bearing: spot.bearing, to: person.to }));
    out.push(agent);
  }
  return out;
}

/** People standing outside right now, across all of the fire's crowd areas. */
export function crowdCount(occupancy: { location: { id: string }; count: number }[], crowd: FireCrowd | null | undefined): number {
  if (!crowd) return 0;
  const ids = new Set(crowd.areas.map((area) => area.id));
  return occupancy.reduce((sum, entry) => sum + (ids.has(entry.location.id) ? entry.count : 0), 0);
}
