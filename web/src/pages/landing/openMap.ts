import type { MouseEvent } from 'react';
import { INTRO_KEY } from '@map/intro';

// "Open the map": the hero is a still of the map filling the window, and the map page opens on that
// same still (map.html shows it before any code loads), so the picture stays put while the page
// changes; only the landing page's cards cross-fade away (@view-transition). The live map then takes
// over at the same framing and its camera flies in (map-client/src/App.tsx, INTRO_STEPS). The still
// is the map's loading screen; there is no other.

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
