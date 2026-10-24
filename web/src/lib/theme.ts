// Light / dark / follow the system. The choice lives on <html data-theme> (read by theme/tokens.css)
// and in localStorage so it survives reloads. Reduce transparency works the same way on
// <html data-transparency="reduced">: tokens.css then turns every glass surface solid.

export type ThemeChoice = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'flowcast.theme';
const TRANSPARENCY_KEY = 'flowcast.transparency';

export function savedTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
}

export function setTheme(choice: ThemeChoice) {
  applyTheme(choice);
  try {
    if (choice === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // storage blocked: the choice lasts for this page load only
  }
}

/** True when the person asked for solid backgrounds instead of see-through glass. */
export function savedTransparency(): boolean {
  try {
    return localStorage.getItem(TRANSPARENCY_KEY) === 'reduced';
  } catch {
    return false;
  }
}

export function applyTransparency(reduced: boolean) {
  const root = document.documentElement;
  if (reduced) root.dataset.transparency = 'reduced';
  else delete root.dataset.transparency;
}

export function setTransparency(reduced: boolean) {
  applyTransparency(reduced);
  try {
    if (reduced) localStorage.setItem(TRANSPARENCY_KEY, 'reduced');
    else localStorage.removeItem(TRANSPARENCY_KEY);
  } catch {
    // storage blocked: the choice lasts for this page load only
  }
}

/** Call once before the first render so the page never flashes the wrong theme or glass. */
export function initTheme() {
  applyTheme(savedTheme());
  applyTransparency(savedTransparency());
}
