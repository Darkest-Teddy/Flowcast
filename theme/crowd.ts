// The crowd scale: Quiet / Busy / Packed. This file is the one definition of the thresholds, words
// and colours; the map (map-client/src/layers/crowdLevels.ts), the dashboard (theme/tokens.ts) and
// the Ask server all read it. theme/tokens.css repeats the colours as --crowd-* variables because
// CSS can't import TypeScript; map-client/tests/crowdScale.test.mjs fails if the two drift, and
// checks every contrast figure claimed below.
//
// Pure data and one function: no imports, no DOM, only erasable TypeScript, so Node's type
// stripping (tests), tsx (server) and Vite (both apps) can all load it as is.
//
// Hues: blue, yellow, rose. Quiet is blue rather than green so it never reads as the dashboard's
// "OK" status green or as a park on the map; nothing else in the UI may use accent blue to mean
// "selected", or blue would read as both. A level is always shown with its word, a number and a
// one/two/three-people icon too, never colour alone.

export type CrowdKey = 'quiet' | 'busy' | 'packed';

export interface CrowdLevelInfo {
  key: CrowdKey;
  label: string;
  /** Lowest share of capacity (0–1+) in this level; it runs up to the next level's `min`. */
  min: number;
  /** Map glow (deck.gl RGBA, 0–255): the level's bright colour, also its fill on dark surfaces. */
  glow: readonly [number, number, number, number];
  /** Text on dark surfaces: the map's glass tags and panel, the dark dashboard. ≥4.5:1. */
  text: string;
  /** Text on light surfaces: white, the light canvas (#f5f5f7) and the light glass. ≥4.5:1. */
  textOnLight: string;
  /** Bars, dots and meters on light surfaces (and the sunken meter track). ≥3:1. */
  fillLight: string;
  /** Bars, dots and meters on dark surfaces: the glow colour as hex. ≥3:1. */
  fillDark: string;
  /** Map only: ground halo alpha, roof tint alpha, roof rim width (px). */
  halo: number;
  roof: number;
  rim: number;
  /** The level's glyph: one, two or three people (HudIcons in map-client/src/hud/Chrome.tsx). */
  icon: 'person1' | 'person2' | 'person3';
}

/** Ordered Quiet → Packed. */
export const CROWD_LEVELS = [
  {
    key: 'quiet', label: 'Quiet', min: 0,
    glow: [56, 189, 248, 150], text: '#7dd3fc', textOnLight: '#0369a1', fillLight: '#0284c7', fillDark: '#38bdf8',
    halo: 80, roof: 30, rim: 4, icon: 'person1',
  },
  {
    key: 'busy', label: 'Busy', min: 0.4,
    glow: [250, 204, 21, 185], text: '#fde047', textOnLight: '#8a5a00', fillLight: '#a87b00', fillDark: '#facc15',
    halo: 130, roof: 54, rim: 6, icon: 'person2',
  },
  {
    key: 'packed', label: 'Packed', min: 0.85,
    glow: [244, 63, 94, 200], text: '#fda4af', textOnLight: '#be123c', fillLight: '#e11d48', fillDark: '#f43f5e',
    halo: 180, roof: 72, rim: 9, icon: 'person3',
  },
] as const satisfies readonly CrowdLevelInfo[];

/**
 * The level for a share of capacity. A share on a boundary takes the upper level (0.40 is Busy,
 * 0.85 Packed). NaN, null, undefined and negative shares are Quiet: an unknown reading never
 * shows as a crowd.
 */
export function crowdLevel(share: number | null | undefined): CrowdLevelInfo {
  if (share == null) return CROWD_LEVELS[0];
  // Comparisons with NaN are false, so NaN falls through to Quiet.
  for (let i = CROWD_LEVELS.length - 1; i > 0; i--) {
    if (share >= CROWD_LEVELS[i].min) return CROWD_LEVELS[i];
  }
  return CROWD_LEVELS[0];
}
