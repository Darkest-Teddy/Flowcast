import { MARK_PATH, MARK_VIEWBOX } from '@theme/mark';

/**
 * The Flowcast mark (theme/mark.ts), one flat shape in the theme's brand blue (--brand-mark). The
 * same art is the favicon (map-client/public/favicon.svg). Decorative: the wordmark beside it
 * names the app.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox={MARK_VIEWBOX} aria-hidden focusable="false">
      <path d={MARK_PATH} style={{ fill: 'var(--brand-mark)' }} />
    </svg>
  );
}
