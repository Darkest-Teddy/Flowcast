// The map's panels follow the time of day on the map, not the dashboard's appearance setting: light
// in daylight, dark from dusk to dawn, so a panel is never the brightest thing over a night scene.
// App calls followLight with the lighting preset it shows (map/daylight.ts), which is real Boston
// time in Clock mode and the shown time when scrubbing. Reduce transparency (<html
// data-transparency>, read by theme/tokens.css) still comes from the dashboard, which stores it
// (web/src/lib/theme.ts) under the same key on the same origin, so a change made in a dashboard
// tab reaches an open map tab through the storage event.
import { presetNow } from './intro';
import type { LightPreset } from './map/basemap';

const TRANSPARENCY_KEY = 'flowcast.transparency';

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage blocked: the default, full transparency
  }
}

function applyStored() {
  const root = document.documentElement;
  if (stored(TRANSPARENCY_KEY) === 'reduced') root.dataset.transparency = 'reduced';
  else delete root.dataset.transparency;
}

/** Light panels only in full daylight; dawn and dusk light the map too dimly for them. */
export function followLight(preset: LightPreset) {
  document.documentElement.dataset.theme = preset === 'day' ? 'light' : 'dark';
}

/** Call once before the first render, so the panels never flash the wrong theme. */
export function syncTheme() {
  applyStored();
  followLight(presetNow());
  window.addEventListener('storage', (e) => {
    // key is null when another tab clears storage.
    if (e.key === null || e.key === TRANSPARENCY_KEY) applyStored();
  });
}
