/*
 * Where a joined student stands on the map.
 *
 * A persona is not part of the simulation: it has no class schedule and no route graph. It gets the
 * simple loop from persona/model.ts -- sit at your home location, walk to one other place, walk back --
 * turned here into the same shape the renderer already draws for everybody else (`WalkingAgent`), so
 * the existing character layers can draw it with no new ScenegraphLayer configuration.
 *
 * Coordinates are never written down here. They come from the map's own location list
 * (`Playback.locations`, loaded from public/data/demo-day.json), so a joined student stands exactly
 * where the simulated crowd stands.
 */

import { CHARACTER_MODELS } from '../layers/agents';
import type { CampusLocation, WalkingAgent } from '../sim/playback';
import { journey, joinedLabel, type Persona } from './model';
import { stockModelFor } from './parts';

/** A joined student, in the shape the character layers draw, with the persona riding along for picking. */
export interface PlacedPersona extends WalkingAgent {
  /** Set only on joined students: what `onClick` and `getTooltip` duck-type on. */
  personaId: string;
  persona: Persona;
  /** "★ Ada" -- the star is what tells a joined student apart from the simulated crowd. */
  label: string;
  walking: boolean;
}

/** `/models/character-male-d.glb` -> its index in CHARACTER_MODELS, which is what a layer needs. */
const MODEL_INDEX = new Map<string, number>(
  CHARACTER_MODELS.map((url, i) => {
    const name = url.replace(/^.*character-/, '').replace(/\.glb$/, '');
    return [name, i];
  }),
);

/**
 * The stock GLB index for a look.
 *
 * The handoff's map-integration note asks for the student's assembled character to be exported to a
 * glTF in memory and drawn in its own layer. That needs three.js in map-client, which this branch
 * does not have, so the closest shipped character is drawn instead: a persona's hair style *is* one
 * of the Kenney heads, so the matching `character-*.glb` is the nearest stock body by construction.
 */
export function modelIndexFor(persona: Persona): number {
  return MODEL_INDEX.get(stockModelFor(persona.appearance)) ?? 0;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Compass bearing (degrees clockwise from north) from one lng/lat to another. */
function bearingBetween(from: [number, number], to: [number, number]): number {
  // Flat-earth is ample over a campus, with a cos(lat) correction so east/west is not stretched.
  const dx = (to[0] - from[0]) * Math.cos((from[1] * Math.PI) / 180);
  const dy = to[1] - from[1];
  if (dx === 0 && dy === 0) return 0;
  return (((Math.atan2(dx, dy) * 180) / Math.PI) + 360) % 360;
}

/**
 * Place every joined student for one instant.
 *
 * `locations` is the map's own list. A persona whose home has no position on this map (or whose
 * target does not) is dropped rather than drawn at [0, 0] in the Atlantic.
 */
export function placePersonas(personas: readonly Persona[], locations: readonly CampusLocation[], nowMs: number): PlacedPersona[] {
  if (personas.length === 0 || locations.length === 0) return [];
  const byId = new Map(locations.map((l) => [l.id, l]));
  const out: PlacedPersona[] = [];
  for (const persona of personas) {
    const j = journey(persona, nowMs);
    const home = byId.get(j.home.id);
    const target = byId.get(j.target.id);
    if (!home) continue;
    const walking = j.phase === 'to-target' || j.phase === 'to-home';
    let position: [number, number, number];
    let bearing: number;
    if (!walking || !target) {
      position = [home.position[0], home.position[1], 0];
      // Standing still, facing a direction that is theirs but never changes between frames.
      bearing = (persona.id.charCodeAt(1) * 37) % 360;
    } else {
      const from = j.phase === 'to-target' ? home : target;
      const to = j.phase === 'to-target' ? target : home;
      position = [lerp(from.position[0], to.position[0], j.progress), lerp(from.position[1], to.position[1], j.progress), 0];
      bearing = bearingBetween(from.position, to.position);
    }
    out.push({
      id: `persona:${persona.id}`,
      model: modelIndexFor(persona),
      position,
      bearing,
      to: walking && target ? (j.phase === 'to-target' ? j.target.id : j.home.id) : j.home.id,
      personaId: persona.id,
      persona,
      label: joinedLabel(persona),
      walking: walking && !!target,
    });
  }
  return out;
}

/** The picked object under the cursor, if it is a joined student. */
export function personaUnder(object: unknown): PlacedPersona | null {
  return object && typeof object === 'object' && 'personaId' in object ? (object as PlacedPersona) : null;
}
