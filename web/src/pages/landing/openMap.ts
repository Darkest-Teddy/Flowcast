import type { MouseEvent } from 'react';
import { INTRO_KEY } from '@map/intro';

// "Open the map": the hero's still of the map grows to fill the window, then the map page opens on
// that same still (map.html shows it before any code loads) and fades it into the live map, which
// flies in from the still's camera. The still is the map's loading screen; there is no other.

/** Marks the hero still the transition grows from. */
export const STILL_ATTR = 'data-intro-still';

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function onScreen(rect: DOMRect): boolean {
  return rect.bottom > 0 && rect.top < window.innerHeight && rect.width > 0;
}

export function openMap(event: MouseEvent<HTMLAnchorElement>) {
  // A new tab or window (modifier keys, middle click) gets the plain link.
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const still = document.querySelector<HTMLImageElement>(`[${STILL_ATTR}]`);
  if (!still?.complete || !still.currentSrc) return;
  event.preventDefault();
  const href = event.currentTarget.href;
  try {
    sessionStorage.setItem(INTRO_KEY, new URL(still.currentSrc).pathname);
  } catch {
    // storage blocked: the map picks its still by the clock
  }
  if (reducedMotion()) return void window.location.assign(href);

  // A copy of the still, fixed over the page, grows from where the hero shows it to the whole
  // window (or, scrolled away from the hero, fades in full size).
  const from = still.getBoundingClientRect();
  const copy = document.createElement('img');
  copy.src = still.currentSrc;
  copy.alt = '';
  Object.assign(copy.style, { position: 'fixed', zIndex: '100', objectFit: 'cover', margin: '0', pointerEvents: 'none' });
  const full = { left: '0px', top: '0px', width: `${window.innerWidth}px`, height: `${window.innerHeight}px`, borderRadius: '0px' };
  const keyframes = onScreen(from)
    ? [
        { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`, borderRadius: '28px', opacity: 0 },
        { opacity: 1, offset: 0.2 },
        { ...full, opacity: 1 },
      ]
    : [
        { ...full, opacity: 0, transform: 'scale(1.04)' },
        { ...full, opacity: 1, transform: 'scale(1)' },
      ];
  document.body.append(copy);
  // Back from the map (the page restored from the back/forward cache): put the page back as it was.
  window.addEventListener('pageshow', () => copy.remove(), { once: true });
  copy
    .animate(keyframes, { duration: 800, easing: 'cubic-bezier(0.65, 0, 0.35, 1)', fill: 'forwards' })
    .finished.then(() => window.location.assign(href), () => window.location.assign(href));
}
