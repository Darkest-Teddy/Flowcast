// Where the sun is over Boston at a given sim time, and what the map's lighting should be.
//
// Auto lighting follows the sim clock (seconds since Boston midnight): real time in Clock mode,
// the shown time when scrubbing or fast-forwarding. Mapbox Standard only has four light presets,
// so we switch them at solar thresholds (civil twilight) and cross-fade everything we draw
// ourselves (model tint, window lights) continuously by the sun's altitude.
import type { LightPreset } from './basemap';

const LAT = 42.3505;
const LON = -71.1054;
const RAD = Math.PI / 180;

/** Boston's UTC offset in hours on a given date (-4 in summer time, -5 in winter). */
function bostonOffsetHours(date: Date): number {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName')?.value;
  const m = part?.match(/GMT([+-]\d+)(?::(\d+))?/);
  return m ? Number(m[1]) + (m[2] ? Math.sign(Number(m[1])) * Number(m[2]) / 60 : 0) : -5;
}

/** UTC milliseconds of Boston midnight on today's Boston date. */
function bostonMidnightUtc(now = new Date()): number {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now); // YYYY-MM-DD
  const [y, mo, d] = ymd.split('-').map(Number);
  const noonUtc = Date.UTC(y, mo - 1, d, 12);
  return Date.UTC(y, mo - 1, d) - bostonOffsetHours(new Date(noonUtc)) * 3600_000;
}

/** Sun altitude in degrees (low-precision solar position, plenty for lighting). */
export function solarAltitude(utcMs: number, lat = LAT, lon = LON): number {
  const n = (utcMs - 946728000000) / 86400000; // days since J2000
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const ha = (gmst * 15 + lon) * RAD - ra;
  return Math.asin(Math.sin(lat * RAD) * Math.sin(dec) + Math.cos(lat * RAD) * Math.cos(dec) * Math.cos(ha)) / RAD;
}

export interface SunTimes {
  /** Seconds since Boston midnight. */
  dawn: number; // civil dawn, sun at -6 deg
  sunrise: number;
  noon: number;
  sunset: number;
  dusk: number; // civil dusk
}

let sunCache: { day: number; times: SunTimes } | null = null;

/** Today's sunrise, sunset and civil twilight in Boston (seconds since local midnight). */
export function bostonSunTimes(now = new Date()): SunTimes {
  const midnight = bostonMidnightUtc(now);
  if (sunCache?.day === midnight) return sunCache.times;
  const alt = (s: number) => solarAltitude(midnight + s * 1000);
  const cross = (from: number, to: number, level: number) => {
    let a = from;
    let b = to;
    for (let i = 0; i < 30; i++) {
      const m = (a + b) / 2;
      if ((alt(a) - level) * (alt(m) - level) <= 0) b = m;
      else a = m;
    }
    return (a + b) / 2;
  };
  let noon = 12 * 3600;
  for (let s = 9 * 3600; s < 15 * 3600; s += 300) if (alt(s) > alt(noon)) noon = s;
  const times = {
    dawn: cross(0, noon, -6),
    sunrise: cross(0, noon, -0.833),
    noon,
    sunset: cross(noon, 86400, -0.833),
    dusk: cross(noon, 86400, -6),
  };
  sunCache = { day: midnight, times };
  return times;
}

export interface Daylight {
  preset: LightPreset;
  altitude: number;
  /** 0 in daylight .. 1 at night: how strongly lit windows show. */
  windows: number;
  /** Multiplier for our own models, matching how dark Mapbox's scene is. */
  tint: [number, number, number, number];
  /** Opacity of a faint blue screen veil that bridges the jumps between Mapbox's presets. */
  veil: number;
}

// Rough darkness of each Mapbox Standard preset, and the continuous darkness we want.
const PRESET_DARKNESS: Record<LightPreset, number> = { day: 0, dawn: 0.35, dusk: 0.35, night: 0.7 };
function darkness(alt: number): number {
  return Math.min(0.7, Math.max(0, ((10 - alt) / 22) * 0.7));
}

const KEYS: [number, [number, number, number]][] = [
  // [sun altitude, tint]
  [-12, [118, 126, 158]],
  [-6, [168, 166, 196]],
  [-2, [206, 196, 214]],
  [3, [236, 222, 214]],
  [10, [255, 255, 255]],
];

function tintAt(alt: number): [number, number, number, number] {
  if (alt <= KEYS[0][0]) return [...KEYS[0][1], 255];
  for (let i = 1; i < KEYS.length; i++) {
    if (alt <= KEYS[i][0]) {
      const [a0, c0] = KEYS[i - 1];
      const [a1, c1] = KEYS[i];
      const f = (alt - a0) / (a1 - a0);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f, 255];
    }
  }
  return [255, 255, 255, 255];
}

let lastKey = -1;
let lastValue: Daylight | null = null;

/** Lighting for a sim time (seconds since Boston midnight, today). Cached per sim half-minute. */
export function daylightAt(seconds: number): Daylight {
  const key = Math.floor(seconds / 30);
  if (key === lastKey && lastValue) return lastValue;
  const sun = bostonSunTimes();
  const midnight = bostonMidnightUtc();
  const altitude = solarAltitude(midnight + seconds * 1000);
  const morning = seconds < sun.noon;
  // Presets switch where the continuous darkness reaches the next preset's, so the veil below
  // can carry the scene smoothly up to each switch: day above -1 deg (just after sunset), twilight
  // down to -12 deg (nautical twilight), night below.
  const preset: LightPreset = altitude > -1 ? 'day' : altitude > -12 ? (morning ? 'dawn' : 'dusk') : 'night';
  const w = Math.min(1, Math.max(0, (5 - altitude) / 11));
  const veil = Math.max(0, darkness(altitude) - PRESET_DARKNESS[preset]) * 0.55;
  lastKey = key;
  lastValue = { preset, altitude, windows: w * w * (3 - 2 * w), tint: tintAt(altitude), veil };
  return lastValue;
}

/** "5:53 PM" for seconds since midnight. */
export function clockLabel(seconds: number): string {
  const m = Math.round(seconds / 60);
  const h = Math.floor(m / 60) % 24;
  return `${h % 12 || 12}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Short status for the lighting control, e.g. "Dusk · sunset 5:53 PM". */
export function daylightLabel(seconds: number): string {
  const sun = bostonSunTimes();
  const { preset } = daylightAt(seconds);
  const name = preset[0].toUpperCase() + preset.slice(1);
  const next = seconds < sun.noon ? `sunrise ${clockLabel(sun.sunrise)}` : `sunset ${clockLabel(sun.sunset)}`;
  return `${name} · ${next}`;
}
