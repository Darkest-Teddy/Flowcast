// The map follows the dashboard's appearance settings: light (the default), dark or the system (<html
// data-theme>, read by theme/tokens.css) and Reduce transparency (<html data-transparency>). The
// dashboard stores them (web/src/lib/theme.ts) under the same keys on the same origin, so a change
// made in a dashboard tab reaches an open map tab through the storage event.

const THEME_KEY = 'flowcast.theme';
const TRANSPARENCY_KEY = 'flowcast.transparency';

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage blocked: the default, light
  }
}

function applyStored() {
  const root = document.documentElement;
  const theme = stored(THEME_KEY);
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme === 'dark' ? 'dark' : 'light';
  if (stored(TRANSPARENCY_KEY) === 'reduced') root.dataset.transparency = 'reduced';
  else delete root.dataset.transparency;
}

/** Call once before the first render, so the panels never flash the wrong theme. */
export function syncTheme() {
  applyStored();
  window.addEventListener('storage', (e) => {
    // key is null when another tab clears storage.
    if (e.key === null || e.key === THEME_KEY || e.key === TRANSPARENCY_KEY) applyStored();
  });
}
