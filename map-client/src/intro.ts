import { daylightAt } from './map/daylight';
import type { LightPreset } from './map/basemap';

// The intro: a still of the map that the landing page shows in its hero and the map shows while it
// loads, then fades into the live map drawn at the same camera. The stills
// (public/intro/<preset>-<1600|3200>.webp) are screenshots of the map's clean view (H) at
// INTRO_VIEW in a 1600×900 window with no panel padding, one per light preset. Retake all four
// when the camera, the models or the base map's look change.

export const INTRO_VIEW = { center: [-71.1018, 42.3477] as [number, number], zoom: 14.9, pitch: 52, bearing: 226 };
export const INTRO_SHOT = { width: 1600, height: 900 };

/** Where some buildings sit in the stills (roof tops, in INTRO_SHOT pixels), for labels drawn over them. */
export const INTRO_ANCHORS: Record<string, [number, number]> = {
  mugar: [1118, 402],
  warren: [937, 436],
  questrom: [820, 533],
  fitrec: [1334, 286],
};

/** sessionStorage: the still the landing page showed, so the map opens on that very file. */
export const INTRO_KEY = 'flowcast.intro';

export function introSources(preset: LightPreset) {
  return { src: `/intro/${preset}-1600.webp`, srcSet: `/intro/${preset}-1600.webp 1600w, /intro/${preset}-3200.webp 3200w` };
}

/** How much a still drawn with object-fit: cover in a width×height box is scaled. */
export function coverScale(width: number, height: number): number {
  return Math.max(width / INTRO_SHOT.width, height / INTRO_SHOT.height);
}

/** The zoom at which the live map lines up with the still covering a width×height window, scaled again by `scale`. */
export function introZoom(width: number, height: number, scale = 1): number {
  return INTRO_VIEW.zoom + Math.log2(coverScale(width, height) * scale);
}

const BOSTON_CLOCK = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** The light preset the live map opens in right now (it follows the sun at Boston's time). */
export function presetNow(): LightPreset {
  const [h, m] = BOSTON_CLOCK.format(new Date()).split(':').map(Number);
  return daylightAt(h * 3600 + m * 60).preset;
}
