// TypeScript view of theme/tokens.css. Values are CSS variable references, so the CSS file stays
// the only place a colour or size is defined (the crowd scale's colours start in theme/crowd.ts
// and are mirrored there); use these where a style has to be set from code (inline styles,
// canvas/deck.gl colours read via resolveToken, chart series).

import { CROWD_LEVELS, crowdLevel, type CrowdKey } from './crowd';

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

/** Liquid glass surfaces. Under reduced transparency these resolve to solid surfaces (tokens.css). */
export const glass = {
  fill: 'var(--glass-fill)',
  fillStrong: 'var(--glass-fill-strong)',
  blur: 'var(--glass-blur)',
  saturate: 'var(--glass-saturate)',
  highlight: 'var(--glass-highlight)',
  border: 'var(--glass-border)',
  innerShadow: 'var(--glass-inner-shadow)',
  shadow: 'var(--glass-shadow)',
  inkTertiary: 'var(--glass-ink-tertiary)',
  canvas: 'var(--canvas-gradient)',
} as const;

/** Small radii for dense controls; card, sheet and capsule for glass surfaces. */
export const radius = {
  xs: 'var(--radius-xs)',
  sm: 'var(--radius-sm)',
  md: 'var(--radius-md)',
  lg: 'var(--radius-lg)',
  full: 'var(--radius-full)',
  card: 'var(--radius-card)',
  sheet: 'var(--radius-sheet)',
  capsule: 'var(--radius-capsule)',
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

export type CrowdLevel = CrowdKey;

/**
 * The one crowd scale every screen uses, built from theme/crowd.ts (thresholds, words) with its
 * colours as CSS variables so they follow the theme. `upTo` is the share of capacity (0–1+) where
 * a level ends (the next level's start). `color` fills bars, dots and meters; `text` is the
 * level's text colour on surfaces and glass.
 */
export const crowdScale: { level: CrowdLevel; label: string; upTo: number; color: string; text: string }[] = CROWD_LEVELS.map(
  (l, i) => ({
    level: l.key,
    label: l.label,
    upTo: CROWD_LEVELS[i + 1]?.min ?? Infinity,
    color: `var(--crowd-${l.key})`,
    text: `var(--crowd-${l.key}-text)`,
  }),
);

/** The scale entry for a share; boundaries go up (0.40 is Moderate) and NaN is Quiet (crowd.ts). */
export function crowdFor(share: number) {
  const key = crowdLevel(share).key;
  return crowdScale.find((s) => s.level === key)!;
}

/** Resolve a token to its computed value, for libraries that can't take a CSS variable. */
export function resolveToken(name: `--${string}`, el: Element = document.documentElement): string {
  return getComputedStyle(el).getPropertyValue(name).trim();
}
