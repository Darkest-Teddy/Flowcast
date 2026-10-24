// Light / dark / follow the system. The choice lives on <html data-theme> (read by theme/tokens.css)
// and in localStorage so it survives reloads.

export type ThemeChoice = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'flowcast.theme';

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

/** Call once before the first render so the page never flashes the wrong theme. */
export function initTheme() {
  applyTheme(savedTheme());
}
