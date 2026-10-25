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

// The map's biggest downloads, fetched into the cache ahead of the click where the whole page can't be.
const MAP_DATA = ['demo-day', 'campus-data', 'transit-schedule', 'bikes', 'transit', 'mobility', 'population', 'street'].map((name) => `/data/${name}.json`);

/**
 * Starts the map before "Open the map" is clicked, once the hero's still is up: hands that still
 * over (the map page reads it as it loads), then asks the browser to prerender the map page, so it
 * downloads and builds the day in the background and opens ready, or nearly: right away on desktop,
 * only when a finger comes down on the link on touch screens. Desktop also prefetches the big data
 * files, for browsers that don't prerender (Brave may not; none does while DevTools automation is
 * attached), so at least the downloads are done. Nothing on Data Saver. Returns a cleanup that
 * drops both when the landing page goes.
 */
export function prepareMap(href: string, still: HTMLImageElement): () => void {
  try {
    sessionStorage.setItem(INTRO_KEY, new URL(still.currentSrc).pathname);
  } catch {
    // storage blocked: the map picks its still by the clock
  }
  if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return () => {};
  const desktop = window.matchMedia('(pointer: fine)').matches;
  const added: HTMLElement[] = [];
  if (HTMLScriptElement.supports?.('speculationrules')) {
    const rules = document.createElement('script');
    rules.type = 'speculationrules';
    rules.textContent = JSON.stringify({ prerender: [{ urls: [href], eagerness: desktop ? 'immediate' : 'moderate' }] });
    added.push(rules);
  }
  if (desktop) {
    for (const url of MAP_DATA) {
      const link = document.createElement('link');
      link.rel = 'prefetch';
      link.href = url;
      added.push(link);
    }
  }
  document.head.append(...added);
  return () => added.forEach((element) => element.remove());
}
