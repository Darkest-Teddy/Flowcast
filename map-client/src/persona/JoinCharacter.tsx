/*
 * The live character on the join card.
 *
 * The invitation asks someone to build a character, so it shows one: a real
 * Kenney figure playing its idle loop, not a picture of one. It is the same
 * renderer the phone flow uses (web/src/lib/personaRender.ts) rather than a
 * second copy, so the character on the display and the one being built on the
 * phone can never look like different products.
 *
 * Three.js is imported dynamically. It is about half a megabyte and the map is
 * already the heaviest page in the project; loading it with the map would charge
 * every visitor for a 48px ornament. This way the card renders its frame
 * immediately and the figure appears when the renderer arrives, which is also
 * the right behaviour when it never does.
 */

import { useEffect, useRef, useState } from 'react';
import { PRESETS } from './parts';
import type { PersonaRenderer } from '../../../web/src/lib/personaRender';

/** The handoff's look for this card, and the only one it ever shows. */
const LOOK = PRESETS[3];

/*
 * Dark, to sit on the card rather than on a page. The ground disc and its shadow
 * are the card's own greys, so the figure stands on the card instead of on a
 * bright plate cut out of it.
 */
const THEME = { ground: '#2c2c2e', shadow: '#151517', outline: '#0b0b0d' };

export function JoinCharacter() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: PersonaRenderer | null = null;
    let dead = false;

    (async () => {
      try {
        const { createPersonaRenderer } = await import('../../../web/src/lib/personaRender');
        if (dead) return;
        renderer = await createPersonaRenderer('/models/');
        if (dead) {
          renderer.dispose();
          return;
        }
        renderer.setTheme(THEME);
        renderer.setOutline(3);
        renderer.setHeadShape(3);
        // No auto-rotate: this card sits in the corner of a display someone is
        // reading a map on, and a thing that never stops turning in the corner
        // of the eye is the one piece of chrome that cannot be ignored.
        renderer.setAutoRotate(false);
        renderer.setReducedMotion(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        renderer.attach(canvas, { app: LOOK, cam: 'full', auto: false, drag: false, ground: true, anim: 'loop' });
      } catch (error) {
        // WebGL refused, the models are missing, or the chunk failed: the card
        // keeps its QR code and simply has no figure beside it.
        console.warn('[flowcast] join character unavailable', error);
        if (!dead) setFailed(true);
      }
    })();

    return () => {
      dead = true;
      renderer?.detach(canvas);
      renderer?.dispose();
    };
  }, []);

  if (failed) return null;
  return <canvas ref={canvasRef} className="join-character" width={96} height={128} aria-hidden="true" />;
}
