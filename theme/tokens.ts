// TypeScript view of theme/tokens.css. Values are CSS variable references, so the CSS file stays
// the only place a colour or size is defined; use these where a style has to be set from code
// (inline styles, canvas/deck.gl colours read via resolveToken, chart series).

export const color = {
  canvas: 'var(--color-canvas)',
  surface: 'var(--color-surface)',
  ink: 'var(--color-ink)',
  inkSecondary: 'var(--color-ink-secondary)',
  inkTertiary: 'var(--color-ink-tertiary)',
  hairline: 'var(--color-hairline)',
  accent: 'var(--color-accent)',
  ok: 'var(--color-ok)',
  warn: 'var(--color-warn)',
  bad: 'var(--color-bad)',
  off: 'var(--color-off)',
} as const;

export const swatches = [
  'var(--swatch-1)',
  'var(--swatch-2)',
  'var(--swatch-3)',
  'var(--swatch-4)',
  'var(--swatch-5)',
  'var(--swatch-6)',
] as const;

/** Stable swatch for a name or id, so the same club or person always gets the same colour. */
export function swatchFor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return swatches[h % swatches.length];
}

export type CrowdLevel = 'quiet' | 'moderate' | 'busy' | 'packed';

/** The one crowd scale every screen uses. `upTo` is the share of capacity (0–1+) where a level ends. */
export const crowdScale: { level: CrowdLevel; label: string; upTo: number; color: string }[] = [
  { level: 'quiet', label: 'Quiet', upTo: 0.4, color: 'var(--crowd-quiet)' },
  { level: 'moderate', label: 'Moderate', upTo: 0.65, color: 'var(--crowd-moderate)' },
  { level: 'busy', label: 'Busy', upTo: 0.85, color: 'var(--crowd-busy)' },
  { level: 'packed', label: 'Packed', upTo: Infinity, color: 'var(--crowd-packed)' },
];

export function crowdFor(share: number) {
  return crowdScale.find((s) => share < s.upTo) ?? crowdScale[crowdScale.length - 1];
}

/** Resolve a token to its computed value, for libraries that can't take a CSS variable. */
export function resolveToken(name: `--${string}`, el: Element = document.documentElement): string {
  return getComputedStyle(el).getPropertyValue(name).trim();
}
