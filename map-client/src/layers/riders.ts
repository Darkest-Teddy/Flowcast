// Riders at Green Line stations and bus / shuttle stops, as the same Kenney characters as the
// walking students (agents.ts).
//
// Every ScenegraphLayer is its own render pass in interleaved mode, so riders add as few layers
// as possible: those walking (to a stop, to the doors, off to a building) go into the students'
// existing walk layers (pass `withRiders(walking, riders)` to agentLayers), and only the people
// standing waiting get layers of their own, one per character model, playing 'idle'.
import { characterLayers, type LoadedModels } from './agents';
import type { WalkingAgent } from '../sim/playback';
import type { RiderSim } from '../sim/riders';

/** Students walking plus riders walking, for agentLayers. */
export function withRiders(walking: WalkingAgent[], riders: RiderSim | null, show = true): WalkingAgent[] {
  return riders && show && riders.walking.length ? walking.concat(riders.walking) : walking;
}

/** People standing waiting at stops (idle). Empty model layers are kept but not drawn. */
export function riderLayers(riders: RiderSim, models: LoadedModels, time: number, zoom: number) {
  return characterLayers(riders.standing, models, time, { id: 'riders-idle', zoom, clip: 'idle', pickable: false, hideEmpty: true });
}
