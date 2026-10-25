// When the last lightning flash went off, shared by the screen flash (WeatherControls) and the
// bolt drawn in the world (atmosphere.ts), so the two always fire together.
let last = { at: -Infinity, seed: 0 };

/** Called as the screen flash starts. */
export function announceStrike() {
  last = { at: performance.now(), seed: last.seed + 1 };
}

/** The most recent strike: when (performance.now() ms) and a counter that seeds its shape and place. */
export const lastStrike = () => last;
