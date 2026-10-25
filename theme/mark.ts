// The Flowcast mark, "Peak cutout": one solid block with the day's crowd peak cut from below. One
// filled path on a 100 x 100 grid, straight edges only, one flat colour. This is its one
// definition: web/src/ui/Logo.tsx and the map's brand (map-client/src/hud/Chrome.tsx) draw it from
// here, filled with var(--brand-mark) (theme/tokens.css), which is these colours per theme.
// map-client/public/favicon.svg repeats the path because a static file can't import it;
// map-client/tests/brandMark.test.mjs fails if any of them drift.
//
// Pure data, only erasable TypeScript, so Node's type stripping (tests) and Vite can load it as is.

export const MARK_VIEWBOX = '0 0 100 100';

export const MARK_PATH = 'M0 0H100V100H79.76V73.81H63.1V47.62H36.9V73.81H20.24V100H0Z';

/** The brand blue: the accent of each theme (--color-accent), so the mark sits with the controls. */
export const MARK_COLOR = { light: '#0066cc', dark: '#2997ff' } as const;
