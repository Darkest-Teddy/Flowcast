const DAY = 86400;
export function advanceTime(seconds: number, elapsedMilliseconds: number, speed: number): number {
  const time = (seconds + Math.max(0, elapsedMilliseconds) * speed / 1000) % DAY;
  return time < 0 ? time + DAY : time;
}
