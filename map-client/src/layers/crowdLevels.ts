// Crowd levels, kept free of rendering imports (and of any dependency) so the Ask server can use
// the same thresholds.

/** RGBA, 0-255; assignable to deck.gl's Color. */
type Rgba = readonly [number, number, number, number];

// One scale for the whole UI: the map glow, the tags and the dashboard bars always agree.
// `glow` is the light colour; `text` is its pale twin, which keeps 4.5:1 or better on the dark
// glass of the tags and panel (5.8:1 worst case, over a white map).
export const LEVELS = [
  { min: 0.85, key: 'packed', label: 'Packed', glow: [244, 63, 94, 200], text: '#fda4af', halo: 180, roof: 72, rim: 9 },
  { min: 0.6, key: 'busy', label: 'Busy', glow: [249, 115, 22, 195], text: '#fdba74', halo: 150, roof: 60, rim: 7 },
  { min: 0.3, key: 'moderate', label: 'Moderate', glow: [250, 204, 21, 185], text: '#fde047', halo: 120, roof: 48, rim: 6 },
  { min: 0, key: 'quiet', label: 'Quiet', glow: [45, 212, 191, 150], text: '#5eead4', halo: 80, roof: 30, rim: 4 },
] as const satisfies readonly { min: number; key: string; label: string; glow: Rgba; text: string; halo: number; roof: number; rim: number }[];

export type CrowdLevel = (typeof LEVELS)[number];

export function crowdLevel(share: number): CrowdLevel {
  return LEVELS.find((level) => share >= level.min) ?? LEVELS[LEVELS.length - 1];
}

