import { useEffect } from 'react';
import Lenis from 'lenis';
import 'lenis/dist/lenis.css';

// Smooth, eased page scrolling for the landing page (Lenis). Only the landing page uses it: the
// dashboard scrolls natively and the map's wheel zooms the map. Off while reduced motion is on.

let lenis: Lenis | null = null;

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)');

/** Turns smooth scrolling on while the calling page is mounted, and follows reduced motion as it changes. */
export function useSmoothScroll() {
  useEffect(() => {
    const media = reducedMotion();
    const sync = () => {
      if (media.matches) {
        lenis?.destroy();
        lenis = null;
      } else if (!lenis) {
        // allowNestedScroll lets scrollable boxes inside the page (menus, wide charts) scroll themselves.
        lenis = new Lenis({ autoRaf: true, allowNestedScroll: true });
      }
    };
    sync();
    media.addEventListener('change', sync);
    return () => {
      media.removeEventListener('change', sync);
      lenis?.destroy();
      lenis = null;
    };
  }, []);
}

/** Scrolls to an element, honouring its scroll-margin-top: eased by Lenis when it's on, instantly otherwise. */
export function scrollToElement(target: HTMLElement, { immediate = false } = {}) {
  if (lenis) lenis.scrollTo(target, { immediate });
  else target.scrollIntoView({ block: 'start' });
}
