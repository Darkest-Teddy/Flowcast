/*
 * Joined students on the map: the characters, and the starred name over each one.
 *
 * The bodies reuse `characterLayers` from layers/agents.ts rather than configuring a second
 * ScenegraphLayer: that is where scale, orientation, the Kenney walk/idle clips, culling and the
 * stable-list diffing live, and a joined student should move exactly like everybody else. Two calls,
 * because one layer plays one clip: the walkers walk, the ones at home idle.
 *
 * The label is a deck.gl TextLayer and not one of the HTML tag overlays (BuildingTags and friends).
 * Those are for a handful of fixed places that need rich hover behaviour; these follow a moving
 * character, there may be two dozen of them, and they only ever show one short string.
 */

import type { Layer } from '@deck.gl/core';
import { TextLayer } from '@deck.gl/layers';
import { CHARACTER_MODELS, characterLayers, type LoadedModels } from '../layers/agents';
import { JOINED_MARK } from './model';
import type { PlacedPersona } from './placement';
import { labelFont } from '../layers/labelFont';

/** Mirrors PHASES in layers/agents.ts, which does not export it. Only used to name layers. */
const WALK_PHASES = 3;

/**
 * Every layer a joined student can be picked from.
 *
 * Needed because a character standing "at" a building stands at its centroid -- inside it -- and the
 * map's invisible building pick-target (`crowd-buildings`) is then physically in front of them, so a
 * plain click returns the building. Re-picking against only these layers ignores everything else's
 * depth, which makes the character itself clickable wherever they are, not just the label above them.
 */
export const PERSONA_PICK_LAYER_IDS: string[] = [
  'persona-labels',
  ...CHARACTER_MODELS.flatMap((_, m) => Array.from({ length: WALK_PHASES }, (_, p) => `personas-walk-${m}-${p}`)),
  ...CHARACTER_MODELS.map((_, m) => `personas-idle-${m}-0`),
];

export interface PersonaLayerOptions {
  zoom: number;
  /** The persona whose details are open, drawn in the highlight colour. */
  selectedId?: string | null;
  /** Labels are the one part worth hiding when the display is zoomed right out. */
  showLabels?: boolean;
}

/** Labels would stack into mush below this zoom, and are unreadable anyway. */
const LABEL_FROM_ZOOM = 15;

export function personaLayers(placed: PlacedPersona[], models: LoadedModels, time: number, options: PersonaLayerOptions) {
  const { zoom, selectedId = null, showLabels = true } = options;
  if (placed.length === 0 || models.length === 0) return [];
  const highlightId = selectedId ? `persona:${selectedId}` : null;
  const walking = placed.filter((p) => p.walking);
  const standing = placed.filter((p) => !p.walking);

  const layers: Layer[] = [
    ...characterLayers(walking, models, time, { id: 'personas-walk', clip: 'walk', pickable: true, zoom, highlightId }),
    ...characterLayers(standing, models, time, { id: 'personas-idle', clip: 'idle', pickable: true, zoom, highlightId }),
  ];

  if (showLabels && zoom >= LABEL_FROM_ZOOM) {
    layers.push(
      new TextLayer<PlacedPersona>({
        id: 'persona-labels',
        data: placed,
        getPosition: (d) => d.position,
        getText: (d) => d.label,
        // Above the character's head rather than at its feet.
        getPixelOffset: [0, -34],
        getSize: 13,
        getColor: [255, 255, 255, 255],
        getBackgroundColor: (d) => (d.personaId === selectedId ? [0, 102, 204, 245] : [24, 28, 36, 225]),
        getBorderColor: [255, 214, 10, 255],
        getBorderWidth: 1,
        background: true,
        backgroundPadding: [6, 3],
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'bottom',
        fontFamily: labelFont(),
        fontWeight: 600,
        // 'auto' builds the font atlas from the data, which is what lets an arbitrary name and the
        // star glyph render at all -- the default character set is ASCII only.
        characterSet: 'auto',
        billboard: true,
        pickable: true,
        parameters: { depthCompare: 'always' },
        updateTriggers: {
          getPosition: time,
          getBackgroundColor: selectedId,
          getText: placed.map((p) => p.label).join('|'),
        },
        // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the label over city geometry.
        slot: 'top',
      }),
    );
  }
  return layers;
}

/** The map's tooltip line for a joined student, so hovering one does not read "Student". */
export function personaTooltip(placed: PlacedPersona): string {
  return `${JOINED_MARK} ${placed.persona.name} · joined · click for details`;
}
