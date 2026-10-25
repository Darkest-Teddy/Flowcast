// Margin of error for a place's simulated head count. A simulated count is an estimate, never an
// exact census: no building is ever truly empty (staff, visitors and people the model doesn't
// simulate), and the simulated students themselves carry day-to-day and assumption uncertainty.
// Display only: counts, occupancy and every total stay the simulation's own numbers.
//
// A heuristic display band, without measured coverage, built from three parts:
//  - sampling: who turns up varies day to day, roughly Poisson: ±1.645·√count;
//  - model: behaviour rates (attendance, visit rates, timing) are assumptions: ±15% of the count;
//  - unmodelled presence: staff, visitors and non-students only ever add people, so the upper
//    end gets at least UNMODELLED_MIN people or UNMODELLED_SHARE of capacity, whichever is more.

const Z90 = 1.645;
export const MODEL_SHARE = 0.15;
export const UNMODELLED_SHARE = 0.03;
export const UNMODELLED_MIN = 2;

export interface CountInterval {
  low: number;
  high: number;
}

/** Heuristic range in people, not a calibrated confidence interval; capacity is 0 if unknown. */
export function countInterval(count: number, capacity: number): CountInterval {
  const c = Math.max(0, count);
  const spread = Z90 * Math.sqrt(c) + MODEL_SHARE * c;
  const unmodelled = Math.max(UNMODELLED_MIN, capacity > 0 ? UNMODELLED_SHARE * capacity : 0);
  return { low: Math.max(0, Math.floor(c - spread)), high: Math.ceil(c + spread + unmodelled) };
}
