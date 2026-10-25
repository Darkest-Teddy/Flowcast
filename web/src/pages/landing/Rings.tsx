/*
 * Contour rings. DESIGN.md §6, the page's signature element.
 *
 * On a topographic map, concentric irregular rings mean "this is where elevation changes."
 * Flowcast measures the same shape of thing: how crowded a place is, radiating out from a
 * point. So ring spacing here is a real encoding, not a decorative tic. A busier place gets
 * tighter rings; a quiet one gets wider ones.
 *
 * The rings are deliberately not perfect circles. They are hand surveyed, not CAD.
 */

type Props = {
  /** 0..1 occupancy. Drives ring spacing: busier reads tighter. */
  share: number;
  /** Rendered size in px. */
  size?: number;
  /** Number of rings drawn. */
  count?: number;
  /** Animate one ring travelling outward. Off inside cards that already move. */
  pulse?: boolean;
  className?: string;
  ringClassName?: string;
  pulseClassName?: string;
};

/*
 * A stable per-ring wobble. Deterministic so the shape never changes between renders,
 * and so server and client agree. No Math.random anywhere.
 */
function wobble(ringIndex: number, vertex: number): number {
  const n = Math.sin(ringIndex * 12.9898 + vertex * 78.233) * 43758.5453;
  return (n - Math.floor(n)) * 2 - 1; // -1..1
}

/**
 * One closed, slightly irregular ring as an SVG path.
 *
 * The outline is a closed Catmull-Rom spline converted to cubic Beziers, so the
 * curve passes exactly through each surveyed vertex and stays smooth across the
 * seam. An earlier quadratic-midpoint version drifted off its own points and read
 * as a thumbprint rather than a contour.
 */
function ringPath(radius: number, ringIndex: number, cx: number, cy: number): string {
  const VERTS = 12;
  const pts: Array<[number, number]> = [];

  for (let v = 0; v < VERTS; v++) {
    const angle = (v / VERTS) * Math.PI * 2;
    // Purely proportional. A constant term distorted the inner rings by ~20% of
    // their own radius, which read as a thumbprint rather than a contour.
    const jitter = wobble(ringIndex, v) * radius * 0.045;
    const r = radius + jitter;
    pts.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r * 0.94]);
  }

  const at = (i: number) => pts[(i + VERTS * 2) % VERTS];
  const n = (v: number) => v.toFixed(2);

  let d = `M${n(pts[0][0])},${n(pts[0][1])}`;
  for (let i = 0; i < VERTS; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${n(c1x)},${n(c1y)} ${n(c2x)},${n(c2y)} ${n(p2[0])},${n(p2[1])}`;
  }
  return `${d}Z`;
}

export function Rings({
  share,
  size = 180,
  count = 6,
  pulse = false,
  className,
  ringClassName,
  pulseClassName,
}: Props) {
  const cx = size / 2;
  const cy = size / 2;
  const maxR = size / 2 - 4;

  /*
   * The encoding. Rings run between an inner floor and the outer edge; a busier
   * place bunches them toward the outside, a quiet one spaces them evenly.
   *
   * The floor matters: without it the innermost rings collapse onto each other
   * and the whole mark reads as a solid blot instead of as measured spacing.
   */
  const innerR = maxR * 0.3;
  const tightness = 0.7 + Math.min(Math.max(share, 0), 1) * 0.85;

  const radii = Array.from({ length: count }, (_, i) => {
    const t = count === 1 ? 1 : i / (count - 1);
    return innerR + (maxR - innerR) * Math.pow(t, tightness);
  });

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      focusable="false"
    >
      {radii.map((r, i) => (
        <path
          key={i}
          className={ringClassName}
          d={ringPath(r, i, cx, cy)}
          strokeWidth={i === radii.length - 1 ? 1.4 : 1}
          opacity={0.22 + (i / count) * 0.5}
        />
      ))}
      {pulse && (
        <path
          className={pulseClassName}
          d={ringPath(maxR * 0.86, 2, cx, cy)}
          strokeWidth={1.3}
          fill="none"
        />
      )}
    </svg>
  );
}
