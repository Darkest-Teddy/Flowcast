/** Pixel displacement from simulation time; no camera mutation or accumulated drift. */
export function impactShake(elapsed: number, radius: number, reducedMotion = false): [number, number] {
  if (reducedMotion || elapsed < 0 || elapsed >= 45) return [0, 0];
  const strength = Math.min(14, 6 + Math.sqrt(Math.max(0, radius)) * 0.5);
  const envelope = (1 - elapsed / 45) ** 3;
  return [
    strength * envelope * (Math.cos(elapsed * 8.7) * 0.7 + Math.sin(elapsed * 17.3) * 0.3),
    strength * envelope * (Math.sin(elapsed * 11.9) * 0.65 + Math.cos(elapsed * 21.1) * 0.35),
  ];
}
