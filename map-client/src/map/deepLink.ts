export function finiteParam(params: URLSearchParams, key: string, min: number, max: number): number | null {
  const raw = params.get(key);
  if (!raw?.trim()) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : null;
}

export function playbackFromUrl(params: URLSearchParams) {
  const rawDate = params.get('date') ?? '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
    && Number.isFinite(Date.parse(`${rawDate}T12:00:00Z`))
    && new Date(`${rawDate}T12:00:00Z`).toISOString().slice(0, 10) === rawDate ? rawDate : null;
  const clock = /^(\d{1,2}):(\d{2})$/.exec(params.get('at') ?? '');
  const at = clock && Number(clock[1]) < 24 && Number(clock[2]) < 60
    ? Number(clock[1]) * 3600 + Number(clock[2]) * 60 : null;
  const speed = finiteParam(params, 'speed', 0, 600);
  return { date, at, speed, live: date === null && at === null && speed === null };
}

/** The panels follow the nearest mapped place when a dashboard link positions the camera. */
export function campusFromUrl(params: URLSearchParams, locations: { position: [number, number]; campus?: string }[]): string {
  const lng = finiteParam(params, 'lng', -180, 180);
  const lat = finiteParam(params, 'lat', -90, 90);
  if (lng === null || lat === null) return 'charles-river';
  const scale = Math.cos(lat * Math.PI / 180);
  let closest = Infinity;
  let campus = 'charles-river';
  for (const location of locations) {
    if (!location.campus) continue;
    const distance = ((location.position[0] - lng) * scale) ** 2 + (location.position[1] - lat) ** 2;
    if (distance < closest) { closest = distance; campus = location.campus; }
  }
  return campus;
}
