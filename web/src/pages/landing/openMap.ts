import type { MouseEvent } from 'react';
import { INTRO_KEY } from '@map/intro';

// "Open the map": the hero is the view of campus from the sky (the intro still under haze and
// clouds) filling the window, and the map page opens on that same picture (map.html shows it before
// any code loads), so it stays put while the page changes; only the headline cross-fades away
// (@view-transition). It is the map's loading screen; when everything is in, the live map takes
// over at the same camera and drops in (map-client/src/App.tsx, INTRO_DROPS).

/** Marks the hero still the map opens on. */
export const STILL_ATTR = 'data-intro-still';

export function openMap(event: MouseEvent<HTMLAnchorElement>) {
  const still = document.querySelector<HTMLImageElement>(`[${STILL_ATTR}]`);
  if (!still?.complete || !still.currentSrc) return;
  // Hand over the very file shown here (the size the browser picked), already decoded.
  try {
    sessionStorage.setItem(INTRO_KEY, new URL(still.currentSrc).pathname);
  } catch {
    // storage blocked: the map picks its still by the clock
  }
}
