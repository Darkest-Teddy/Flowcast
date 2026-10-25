/*
 * Holographic depth for the title sequence.
 *
 * Two things move together and that is what sells it:
 *
 *   1. The real camera. The backdrop is an actual 3D scene, so nudging the deck.gl
 *      camera with the pointer gives true parallax -- near buildings sweep further
 *      than far ones and occlusion stays correct. No CSS trick reproduces that.
 *   2. The overlay. The wordmark, lede and actions sit on separate Z planes inside a
 *      `perspective` container and counter-move, so they read as floating in front
 *      of the scene rather than painted onto it.
 *
 * Values are written to CSS custom properties on a host element, not to React
 * state. A spring running at 60fps through setState would re-render the whole hero
 * every frame; custom properties let CSS do the work and keep React out of it.
 *
 * Honest limits: pointer depth is for pointer devices only, and everything here is
 * disabled under prefers-reduced-motion. Motion is never the only cue -- the title
 * screen is fully readable and operable with all of it switched off.
 */

import { useEffect, useRef } from 'react';

export interface DepthState {
  /** Pointer, -1..1 from the centre of the host. */
  x: number;
  y: number;
  /** 0 at the top of the title screen, 1 once it has been scrolled past. */
  scroll: number;
  /** True while the pointer is over the host. */
  active: boolean;
}

export interface UseDepthOptions {
  /** Called each frame with the smoothed state, for driving the 3D camera. */
  onFrame?: (state: DepthState) => void;
  /** How quickly the smoothed value chases the raw one. 0..1 per frame. */
  ease?: number;
  /** Switches everything off (the caller may know motion is unwanted). */
  disabled?: boolean;
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const canHover = () => typeof window !== 'undefined' && window.matchMedia('(hover: hover)').matches;

export function useDepth<T extends HTMLElement>({ onFrame, ease = 0.085, disabled = false }: UseDepthOptions = {}) {
  const hostRef = useRef<T>(null);
  const frameRef = useRef(0);

  // Raw targets, written by events. Smoothed values, written by the frame loop.
  const target = useRef<DepthState>({ x: 0, y: 0, scroll: 0, active: false });
  const smooth = useRef<DepthState>({ x: 0, y: 0, scroll: 0, active: false });

  // Kept in a ref so changing the callback never restarts the loop.
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const reduced = prefersReducedMotion();
    const hover = canHover();
    const off = disabled || reduced;

    const writeVars = (s: DepthState) => {
      host.style.setProperty('--depth-x', s.x.toFixed(4));
      host.style.setProperty('--depth-y', s.y.toFixed(4));
      host.style.setProperty('--depth-scroll', s.scroll.toFixed(4));
    };

    if (off) {
      // Neutral, once. The layout is identical; only the movement is gone.
      writeVars({ x: 0, y: 0, scroll: 0, active: false });
      // Scroll still has to drive the handoff, even with motion off.
      if (!reduced) return;
    }

    const onPointerMove = (e: PointerEvent) => {
      if (!hover || e.pointerType !== 'mouse') return;
      const r = host.getBoundingClientRect();
      target.current.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      target.current.y = ((e.clientY - r.top) / r.height) * 2 - 1;
      target.current.active = true;
    };

    const onPointerLeave = () => {
      // Returns to rest rather than snapping, so leaving the hero is not a jolt.
      target.current.x = 0;
      target.current.y = 0;
      target.current.active = false;
    };

    const readScroll = () => {
      const r = host.getBoundingClientRect();
      const travel = r.height || 1;
      // 0 while the title fills the viewport, 1 once it has been scrolled past.
      target.current.scroll = Math.min(Math.max(-r.top / travel, 0), 1);
    };

    const tick = () => {
      const t = target.current;
      const s = smooth.current;
      const k = off ? 1 : ease;
      s.x += (t.x - s.x) * k;
      s.y += (t.y - s.y) * k;
      s.scroll += (t.scroll - s.scroll) * (off ? 1 : 0.14);
      s.active = t.active;

      writeVars(s);
      onFrameRef.current?.(s);
      frameRef.current = requestAnimationFrame(tick);
    };

    readScroll();
    if (!off) {
      host.addEventListener('pointermove', onPointerMove, { passive: true });
      host.addEventListener('pointerleave', onPointerLeave, { passive: true });
    }
    window.addEventListener('scroll', readScroll, { passive: true });
    window.addEventListener('resize', readScroll, { passive: true });
    frameRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frameRef.current);
      host.removeEventListener('pointermove', onPointerMove);
      host.removeEventListener('pointerleave', onPointerLeave);
      window.removeEventListener('scroll', readScroll);
      window.removeEventListener('resize', readScroll);
    };
  }, [disabled, ease]);

  return { hostRef, depth: smooth };
}
