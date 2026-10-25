// How long one free-time visit lasts (a meal, a study session, a workout, a night out): the menu's
// `minutes` is the mean, and each visit draws a skewed length around it, so people trickle out of a
// dining hall instead of leaving in waves. Used by both the plain day and the conditions engine
// (sim/sourceDay.ts, scalar `visitLengthSpread`).
//
// Assumption, uncalibrated: visit lengths are lognormal with a log-space standard deviation of
// 0.45 (coefficient of variation ≈ 0.47), scaled so the mean equals the menu's minutes. The median
// visit is then ≈ 0.9× the mean, one in ten is shorter than ≈ 0.5× and one in ten longer than
// ≈ 1.6×. Dwell times in restaurants, libraries and gyms are commonly right-skewed like this; the
// width is a scenario choice, not fitted to BU data. 30% of the log-variance is a stable personal
// trait per kind of visit (some people linger over dinner every day), the rest varies visit to visit.

/** Log-space standard deviation of visit lengths in the plain day (the `visitLengthSpread` base). */
export const VISIT_LENGTH_SIGMA = 0.45;
/** Share of the log-variance that is a stable personal habit rather than a per-visit draw. */
export const VISIT_LENGTH_PERSONAL_SHARE = 0.3;
/** Visits are kept between these multiples of the mean (cuts < 1% of draws; the mean moves < 0.5%). */
export const VISIT_LENGTH_BOUNDS: readonly [number, number] = [0.3, 3.5];

export const VISIT_LENGTH_ASSUMPTION = 'Free-time visit lengths are skewed, not fixed: each meal, study session, workout or outing draws a stable lognormal length (log-space σ 0.45 in the plain day, the `visitLengthSpread` scalar under the conditions engine) whose mean is the menu duration, so the median visit is about 0.9× the mean and one in ten lasts over 1.6×; 30% of the variation is a stable personal habit. Uncalibrated scenario assumption.';

/** A standard normal deviate from two uniform draws in [0, 1) (Box–Muller). */
export function normalFrom(u1: number, u2: number): number {
  return Math.sqrt(-2 * Math.log(1 - u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Multiplier on the menu's mean minutes for one visit. `personal` and `visit` are standard normal
 * deviates (the student's stable habit for this kind of visit, and this visit's own draw); `sigma`
 * is the log-space spread (0 = every visit lasts exactly the mean). Mean-preserving: E = 1 before
 * the bounds.
 */
export function visitLengthFactor(personal: number, visit: number, sigma: number): number {
  if (!(sigma > 0)) return 1;
  const z = Math.sqrt(VISIT_LENGTH_PERSONAL_SHARE) * personal + Math.sqrt(1 - VISIT_LENGTH_PERSONAL_SHARE) * visit;
  return Math.max(VISIT_LENGTH_BOUNDS[0], Math.min(VISIT_LENGTH_BOUNDS[1], Math.exp(sigma * z - sigma * sigma / 2)));
}
