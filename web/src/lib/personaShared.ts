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

export {
  MAX_PERSONAS,
  myPersonaId,
  readPersonas,
  removePersona,
  savePersona,
  setMyPersonaId,
  subscribePersonas,
} from '@map/persona/store';
