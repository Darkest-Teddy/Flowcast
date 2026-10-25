/*
 * The persona model, under the name the design handoff uses.
 *
 * The handoff refers to `web/src/lib/personaShared.ts` and to `statusText()` living here. The model
 * itself cannot live in this folder: the map display needs the same types, the same location list and
 * the same journey arithmetic, and map-client cannot import from web (only web aliases across, via
 * `@map/*`). So the one implementation sits in `map-client/src/persona/`, and this is the name the
 * handoff asked for pointing at it.
 */

export {
  DEFAULT_LOCATION_ID,
  JOINED_MARK,
  LOCATIONS,
  hashId,
  isWalking,
  joinedLabel,
  journey,
  locationName,
  newPersonaId,
  planText,
  statusText,
  type Appearance,
  type CampusLocation,
  type Journey,
  type Persona,
  type Phase,
} from '@map/persona/model';

/*
 * The join flow's half of the store. The phone writes one character and recovers it on a revisit;
 * it never reads the list, because it has no map to draw -- that is the display's side
 * (readPersonas/subscribePersonas, used only by map-client/src/App.tsx).
 */
export {
  MAX_PERSONAS,
  forgetMyPersona,
  myPersonaId,
  readMyPersona,
  removeMyPersona,
  saveMyPersona,
  type MyPersona,
  type PersonaDraft,
  type SaveResult,
} from '@map/persona/store';
