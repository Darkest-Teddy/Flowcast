import type { Trip, WalkRoute } from './playback';
import { polyline } from './fireEvacuation';

/** Escape on the current saved path only when every segment leads away from impact. */
export function meteorEscape(trip: Trip, at: number, center: [number, number], radius: number, blocked: Set<string>) {
  const times = trip.timestamps;
  let i = 1;
  while (i < times.length - 1 && times[i] <= at) i++;
  const f = (at - times[i - 1]) / (times[i] - times[i - 1]);
  const a = trip.path[i - 1], b = trip.path[i];
  const point: [number, number] = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  const kx = 111320 * Math.cos(center[1] * Math.PI / 180);
  const xy = (p: [number, number]) => [(p[0] - center[0]) * kx, (p[1] - center[1]) * 111320];
  const distance = (p: [number, number]) => Math.hypot(...xy(p));
  if (distance(point) > radius) return undefined;
  const approach: WalkRoute = { path: [...trip.path.slice(0, i), point],
    cumulative: [...times.slice(0, i).map(t => t - times[0]), at - times[0]] };
  const candidates = [
    { destination: trip.to, path: [point, ...trip.path.slice(i)] },
    { destination: trip.from, path: [...approach.path].reverse() },
  ].filter(({ destination, path }) => !blocked.has(destination) && distance(path.at(-1)!) > radius
    && path.every((p, index) => {
      if (!index) return true;
      const u = xy(path[index - 1]), v = xy(p);
      // Nonnegative radial derivative prevents a segment from cutting toward the impact.
      return u[0] * (v[0] - u[0]) + u[1] * (v[1] - u[1]) >= -1e-7;
    })).map(candidate => ({ destination: candidate.destination, route: polyline(candidate.path) }))
    .filter(candidate => candidate.route.cumulative.at(-1)! > 0)
    .sort((a, b) => a.route.cumulative.at(-1)! - b.route.cumulative.at(-1)! || a.destination.localeCompare(b.destination));
  return candidates[0] ? { ...candidates[0], approach } : undefined;
}
