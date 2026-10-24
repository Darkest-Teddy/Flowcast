// Frame pacing: render on a steady beat instead of as often as the display refreshes.
//
// On a 120 Hz screen (ProMotion, many external monitors) the map can't finish every frame in 8 ms,
// so it ran at whatever it managed: frames of 8, 17 and 25 ms in an uneven mix, which reads as
// judder and drags the 1% low down. Capped at 60, every frame gets 16.7 ms and lands on the same
// beat. The cap renders on every Nth display refresh (N = refresh rate / cap, rounded), so a
// 120 Hz screen draws every other refresh, 144 Hz every other (72 FPS) and 60 Hz every one.
//
// Everything that renders asks `shouldRender(timestamp)` with its requestAnimationFrame timestamp:
// the app's frame loop, Mapbox's render (patched in basemap.ts, so deck.gl's interleaved layers
// follow) and the perf monitor. All callbacks of one display frame share that timestamp, so they
// all get the same answer. Off by default (the map renders on every refresh it can); ?fps=60
// (or any number) turns the cap on.

const fromUrl = new URLSearchParams(window.location.search).get('fps');
const CAP = fromUrl === null ? 0 : Math.max(0, Number(fromUrl) || 0);

let vsync = 1000 / 60; // estimated display refresh interval, ms
let lastTimestamp = 0;
let lastRender = -Infinity;
let decidedFor = -1;
let decision = true;
const deltas: number[] = [];

/** The refresh interval: a low percentile of recent frame gaps, so slow frames don't skew it. */
function estimateVsync(): number {
  const sorted = [...deltas].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.2)];
}

export const pacer = {
  get cap() {
    return CAP;
  },
  /** Display refreshes per rendered frame (1 when uncapped or the display is at or below the cap). */
  get every() {
    return CAP ? Math.max(1, Math.round(1000 / vsync / CAP)) : 1;
  },
  /** Whether the display frame with this requestAnimationFrame timestamp should be drawn. */
  shouldRender(timestamp: number): boolean {
    if (timestamp === decidedFor) return decision;
    if (lastTimestamp) {
      const d = timestamp - lastTimestamp;
      if (d > 2 && d < 50) {
        deltas.push(d);
        if (deltas.length > 120) deltas.shift();
        if (deltas.length >= 20) vsync = estimateVsync();
      }
    }
    lastTimestamp = timestamp;
    decidedFor = timestamp;
    // Half a refresh of slack, so a frame that arrives a little early still counts as on the beat.
    decision = timestamp - lastRender >= pacer.every * vsync - vsync / 2;
    if (decision) lastRender = timestamp;
    return decision;
  },
};

/**
 * Pace a Mapbox or MapLibre map's rendering: its internal `_render(timestamp)` runs only on
 * paced frames; on the others it asks for the next frame instead, so nothing is dropped, only
 * deferred to the beat. Both libraries call `_render` from their requestAnimationFrame callback.
 */
export function paceMapRendering(map: unknown) {
  const m = map as { _render?: (t?: number) => unknown; triggerRepaint?: () => void };
  if (!CAP || typeof m._render !== 'function' || typeof m.triggerRepaint !== 'function') return;
  const render = m._render.bind(m);
  m._render = (timestamp?: number) => {
    if (typeof timestamp === 'number' && !pacer.shouldRender(timestamp)) {
      m.triggerRepaint!();
      return m;
    }
    return render(timestamp);
  };
}
