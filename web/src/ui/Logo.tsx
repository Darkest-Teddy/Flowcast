import { useId } from 'react';

/**
 * The Flowcast mark: a day's crowd curve rising to its peak, on a teal-to-blue tile. The same art
 * is the favicon (map-client/public/favicon.svg). Decorative: the wordmark beside it names the app.
 */
export function Logo({ className }: { className?: string }) {
  const gradient = useId();
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden focusable="false">
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--brand-start)' }} />
          <stop offset="1" style={{ stopColor: 'var(--brand-end)' }} />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${gradient})`} />
      <path d="M6.5 22.5c4 0 5-11 9.5-11s5.5 11 9.5 11" fill="none" style={{ stroke: 'var(--brand-ink)' }} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16" cy="11.5" r="1.9" style={{ fill: 'var(--brand-ink)' }} />
    </svg>
  );
}
