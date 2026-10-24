// Weather for BU: live conditions from Open-Meteo (free, no key, CORS-open), what each condition
// looks like on the map (Mapbox v3 rain / snow / fog plus a light screen tint), and the small,
// clearly-labelled campus impact from plan Section 5.6 ("rain favours indoor destinations").
import type { Occupancy } from '../sim/playback';

export type Condition =
  | 'clear'
  | 'partly-cloudy'
  | 'cloudy'
  | 'fog'
  | 'drizzle'
  | 'rain'
  | 'heavy-rain'
  | 'snow'
  | 'thunderstorm'
  | 'heatwave';

/** What the control is set to: the real Boston weather, or a simulated regime. */
export type WeatherMode = 'live' | 'clear' | 'rain' | 'snow' | 'fog' | 'thunderstorm' | 'heatwave';
export const WEATHER_MODES: { mode: WeatherMode; label: string; title: string }[] = [
  { mode: 'live', label: 'Live', title: "Boston University's actual weather right now" },
  { mode: 'clear', label: 'Clear', title: 'Simulate a clear day' },
  { mode: 'rain', label: 'Rain', title: 'Simulate steady rain' },
  { mode: 'snow', label: 'Snow', title: 'Simulate snowfall' },
  { mode: 'fog', label: 'Fog', title: 'Simulate fog' },
  { mode: 'thunderstorm', label: 'Storm', title: 'Simulate a thunderstorm' },
  { mode: 'heatwave', label: 'Heat', title: 'Simulate a heatwave' },
];

/** One Open-Meteo reading for BU (42.3505, -71.1054). */
export interface WeatherReading {
  code: number; // WMO weather code
  condition: Condition;
  text: string; // "Mostly clear", "Light rain"
  temperatureF: number;
  feelsLikeF: number;
  precipitationMm: number; // over the preceding 15 minutes
  snowfallCm: number; // over the preceding 15 minutes
  cloudCover: number; // %
  windMph: number;
  windFromDeg: number; // meteorological: where the wind comes from
  visibilityM: number;
  isDay: boolean;
  observedAt: string; // local ISO time of the observation, "2026-10-24T12:15"
}

/** What the map and panel show right now. */
export interface ActiveWeather {
  mode: WeatherMode;
  live: boolean; // true: a real reading; false: simulated (or Live with no data yet)
  condition: Condition;
  text: string;
  temperatureF: number | null;
  reading: WeatherReading | null; // the latest real reading, if any, even while simulating
  effect: WeatherEffect;
}

type Spec = Record<string, unknown>;

export interface WeatherEffect {
  /** Mapbox v3 setRain / setSnow / setFog specs. null clears rain and snow, and restores the style's own fog. */
  rain: Spec | null;
  snow: Spec | null;
  fog: Spec | null;
  /** Screen overlay drawn by WeatherControls over either map. */
  overlay: {
    tint: string | null; // multiplied over the map: dims and colours the light
    haze: number; // 0..1 strength of a distance haze, thicker toward the horizon
    hazeTone: 'cool' | 'warm';
    lightning: boolean;
  };
}

const API_URL =
  'https://api.open-meteo.com/v1/forecast?latitude=42.3505&longitude=-71.1054' +
  '&current=temperature_2m,apparent_temperature,precipitation,rain,snowfall,weather_code,cloud_cover,' +
  'wind_speed_10m,wind_direction_10m,visibility,is_day' +
  '&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FNew_York';

export const REFRESH_MS = 10 * 60_000;
export const RETRY_MS = 60_000;
const CACHE_KEY = 'flowcast.weather';
const CACHE_MAX_AGE_MS = 3 * 3600_000;

// WMO 4677 codes as Open-Meteo reports them.
const WMO: Record<number, [Condition, string]> = {
  0: ['clear', 'Clear'],
  1: ['clear', 'Mostly clear'],
  2: ['partly-cloudy', 'Partly cloudy'],
  3: ['cloudy', 'Overcast'],
  45: ['fog', 'Fog'],
  48: ['fog', 'Freezing fog'],
  51: ['drizzle', 'Light drizzle'],
  53: ['drizzle', 'Drizzle'],
  55: ['drizzle', 'Heavy drizzle'],
  56: ['drizzle', 'Freezing drizzle'],
  57: ['drizzle', 'Freezing drizzle'],
  61: ['rain', 'Light rain'],
  63: ['rain', 'Rain'],
  65: ['heavy-rain', 'Heavy rain'],
  66: ['rain', 'Freezing rain'],
  67: ['heavy-rain', 'Heavy freezing rain'],
  71: ['snow', 'Light snow'],
  73: ['snow', 'Snow'],
  75: ['snow', 'Heavy snow'],
  77: ['snow', 'Snow grains'],
  80: ['rain', 'Light showers'],
  81: ['rain', 'Showers'],
  82: ['heavy-rain', 'Violent showers'],
  85: ['snow', 'Snow showers'],
  86: ['snow', 'Heavy snow showers'],
  95: ['thunderstorm', 'Thunderstorm'],
  96: ['thunderstorm', 'Thunderstorm, hail'],
  99: ['thunderstorm', 'Thunderstorm, heavy hail'],
};

export function describeCode(code: number): [Condition, string] {
  return WMO[code] ?? ['cloudy', 'Unknown'];
}

/** Fetch the current BU conditions. Throws on network or API failure. */
export async function fetchWeather(signal?: AbortSignal): Promise<WeatherReading> {
  const res = await fetch(API_URL, { signal, cache: 'no-store' });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const c = (await res.json()).current;
  if (!c || typeof c.weather_code !== 'number') throw new Error('Open-Meteo: no current conditions');
  const [condition, text] = describeCode(c.weather_code);
  const reading: WeatherReading = {
    code: c.weather_code,
    condition,
    text,
    temperatureF: c.temperature_2m,
    feelsLikeF: c.apparent_temperature,
    precipitationMm: c.precipitation ?? 0,
    snowfallCm: c.snowfall ?? 0,
    cloudCover: c.cloud_cover ?? 0,
    windMph: c.wind_speed_10m ?? 0,
    windFromDeg: c.wind_direction_10m ?? 0,
    visibilityM: c.visibility ?? 50_000,
    isDay: c.is_day === 1,
    observedAt: c.time,
  };
  // A real heatwave shows as one (clear skies at 90°F+ "feels like").
  if ((condition === 'clear' || condition === 'partly-cloudy') && reading.feelsLikeF >= 90) {
    reading.condition = 'heatwave';
    reading.text = `Hot · ${text.toLowerCase()}`;
  }
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), reading }));
  } catch {
    /* private mode */
  }
  return reading;
}

/** The last good reading from this browser, if recent: keeps Live honest through a venue Wi-Fi blip on reload. */
export function cachedWeather(): { reading: WeatherReading; at: number } | null {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null');
    if (cached && Date.now() - cached.at < CACHE_MAX_AGE_MS) return cached;
  } catch {
    /* ignore */
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Effects

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Mapbox's precipitation direction is [azimuth, polar]: azimuth in the map plane, polar the angle
 * below the horizon (90 = straight down). Weather reports where wind comes *from*; drops travel
 * the other way, and stronger wind slants them more.
 */
function fallDirection(windFromDeg: number, windMph: number, calmPolar: number, maxSlant: number): [number, number] {
  const towardCompass = (windFromDeg + 180) % 360;
  const azimuth = (450 - towardCompass) % 360; // compass (clockwise from north) to math angle (from east)
  return [Math.round(azimuth), Math.round(calmPolar - clamp(windMph * 1.6, 0, maxSlant))];
}

// Colours that follow the light: Standard's "brightness" is ~0.1 at night and ~0.45 at midday,
// so the same fog reads as pale haze by day and dark murk at dusk.
const byLight = (dark: string, light: string) => ['interpolate', ['linear'], ['measure-light', 'brightness'], 0.1, dark, 0.4, light];

// Ranges stay within the base map's distance haze ([0.8, 3.2]), which basemap.ts merges these into.
function fog(range: [number, number], dark: string, light: string, highDark: string, highLight: string, horizonBlend?: number): Spec {
  return {
    range,
    color: byLight(dark, light),
    'high-color': byLight(highDark, highLight),
    'space-color': byLight(highDark, highLight),
    ...(horizonBlend === undefined ? {} : { 'horizon-blend': horizonBlend }),
    'star-intensity': 0,
  };
}

const NO_OVERLAY: WeatherEffect['overlay'] = { tint: null, haze: 0, hazeTone: 'cool', lightning: false };

/** Rain from 0 (a drizzle) to 1 (a downpour). */
function rainSpec(strength: number, windFromDeg: number, windMph: number): Spec {
  return {
    density: Number((0.3 + 0.5 * strength).toFixed(2)),
    intensity: Number((0.75 + 0.25 * strength).toFixed(2)),
    opacity: Number((0.55 + 0.25 * strength).toFixed(2)),
    vignette: Number((0.25 + 0.35 * strength).toFixed(2)),
    'center-thinning': 0.45,
    'droplet-size': [2.4, 14 + 6 * strength],
    'distortion-strength': 0.3, // more smears the labels
    direction: fallDirection(windFromDeg, windMph, 84, 22),
  };
}

function snowSpec(strength: number, windFromDeg: number, windMph: number): Spec {
  return {
    density: Number((0.5 + 0.45 * strength).toFixed(2)),
    intensity: Number((0.55 + 0.3 * strength).toFixed(2)),
    opacity: 0.9,
    vignette: Number((0.15 + 0.25 * strength).toFixed(2)),
    'vignette-color': '#dfe7f2',
    'center-thinning': 0.3,
    'flake-size': Number((0.75 + 0.3 * strength).toFixed(2)),
    direction: fallDirection(windFromDeg, windMph, 78, 40),
  };
}

/** What a condition looks like. `strength` (0..1) scales precipitation; Live derives it from the measured amount. */
export function effectFor(condition: Condition, strength: number, wind: { fromDeg: number; mph: number }): WeatherEffect {
  const s = clamp(strength, 0, 1);
  const { fromDeg, mph } = wind;
  switch (condition) {
    case 'clear':
    case 'partly-cloudy':
      return { rain: null, snow: null, fog: null, overlay: NO_OVERLAY };
    case 'cloudy':
      return {
        rain: null,
        snow: null,
        fog: fog([0.6, 3.2], 'hsl(220, 14%, 22%)', 'hsl(213, 14%, 84%)', 'hsl(220, 16%, 18%)', 'hsl(213, 16%, 76%)'),
        overlay: { tint: '#dde2ea', haze: 0.15, hazeTone: 'cool', lightning: false },
      };
    case 'fog':
      return {
        rain: null,
        snow: null,
        fog: fog([-0.6, 1.6], 'hsl(220, 10%, 40%)', 'hsl(210, 10%, 86%)', 'hsl(220, 10%, 34%)', 'hsl(210, 10%, 82%)', 0.3),
        overlay: { tint: '#e6e9ee', haze: 0.55, hazeTone: 'cool', lightning: false },
      };
    case 'drizzle':
    case 'rain':
    case 'heavy-rain':
      return {
        rain: rainSpec(s, fromDeg, mph),
        snow: null,
        fog: fog([0.4, 3], 'hsl(220, 16%, 18%)', 'hsl(212, 12%, 74%)', 'hsl(220, 18%, 15%)', 'hsl(212, 14%, 66%)'),
        overlay: { tint: s > 0.6 ? '#c6ceda' : '#d4dae4', haze: 0.2 + 0.15 * s, hazeTone: 'cool', lightning: false },
      };
    case 'snow':
      return {
        rain: null,
        snow: snowSpec(s, fromDeg, mph),
        fog: fog([0.2, 2.8], 'hsl(220, 12%, 26%)', 'hsl(210, 20%, 90%)', 'hsl(220, 14%, 22%)', 'hsl(210, 22%, 84%)'),
        overlay: { tint: '#e4e9f1', haze: 0.3 + 0.15 * s, hazeTone: 'cool', lightning: false },
      };
    case 'thunderstorm':
      return {
        rain: rainSpec(Math.max(s, 0.85), fromDeg, Math.max(mph, 12)),
        snow: null,
        fog: fog([0.2, 2.6], 'hsl(225, 20%, 12%)', 'hsl(218, 12%, 50%)', 'hsl(225, 22%, 10%)', 'hsl(218, 14%, 44%)'),
        overlay: { tint: '#aab3c3', haze: 0.3, hazeTone: 'cool', lightning: true },
      };
    case 'heatwave':
      return {
        rain: null,
        snow: null,
        fog: fog([0.3, 3], 'hsl(25, 30%, 24%)', 'hsl(36, 70%, 82%)', 'hsl(25, 34%, 20%)', 'hsl(32, 70%, 78%)', 0.3),
        overlay: { tint: '#fff4e8', haze: 0.28, hazeTone: 'warm', lightning: false },
      };
  }
}

/** Precipitation strength (0..1) from a real reading: measured rate where there is one, else the code's wording. */
function liveStrength(r: WeatherReading): number {
  if (r.condition === 'snow') {
    const cmPerHour = r.snowfallCm * 4; // the reading covers 15 minutes
    const fromCode = r.code === 71 || r.code === 77 ? 0.25 : r.code === 75 || r.code === 86 ? 0.85 : 0.5;
    return cmPerHour > 0 ? clamp(Math.sqrt(cmPerHour / 3), 0.15, 1) : fromCode;
  }
  const mmPerHour = r.precipitationMm * 4;
  const fromCode = r.condition === 'drizzle' ? 0.1 : r.condition === 'heavy-rain' || r.condition === 'thunderstorm' ? 0.85 : 0.45;
  // 1 mm/h is light rain, 8 mm/h heavy (AMS glossary).
  return mmPerHour > 0 ? clamp(Math.sqrt(mmPerHour / 8), 0.1, 1) : fromCode;
}

// Representative conditions for the simulated regimes. Wind follows the live reading when there is one.
const SIMULATED: Record<Exclude<WeatherMode, 'live'>, { condition: Condition; text: string; temperatureF: number; strength: number }> = {
  clear: { condition: 'clear', text: 'Clear', temperatureF: 62, strength: 0 },
  rain: { condition: 'rain', text: 'Steady rain', temperatureF: 50, strength: 0.55 },
  snow: { condition: 'snow', text: 'Snow', temperatureF: 28, strength: 0.55 },
  fog: { condition: 'fog', text: 'Fog', temperatureF: 47, strength: 0 },
  thunderstorm: { condition: 'thunderstorm', text: 'Thunderstorm', temperatureF: 74, strength: 0.9 },
  heatwave: { condition: 'heatwave', text: 'Heatwave', temperatureF: 96, strength: 0 },
};

export function activeWeather(mode: WeatherMode, reading: WeatherReading | null): ActiveWeather {
  const wind = reading ? { fromDeg: reading.windFromDeg, mph: reading.windMph } : { fromDeg: 250, mph: 8 };
  if (mode === 'live') {
    if (!reading) {
      return { mode, live: false, condition: 'clear', text: 'Live weather unavailable', temperatureF: null, reading, effect: effectFor('clear', 0, wind) };
    }
    // The map treats a lot of cloud as overcast even when the code says "partly".
    const condition = reading.condition === 'partly-cloudy' && reading.cloudCover >= 85 ? 'cloudy' : reading.condition;
    return {
      mode,
      live: true,
      condition,
      text: reading.text,
      temperatureF: reading.temperatureF,
      reading,
      effect: effectFor(condition, liveStrength(reading), wind),
    };
  }
  const sim = SIMULATED[mode];
  return { mode, live: false, condition: sim.condition, text: sim.text, temperatureF: sim.temperatureF, reading, effect: effectFor(sim.condition, sim.strength, wind) };
}

export function nextMode(mode: WeatherMode): WeatherMode {
  const i = WEATHER_MODES.findIndex((m) => m.mode === mode);
  return WEATHER_MODES[(i + 1) % WEATHER_MODES.length].mode;
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compass = (deg: number) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];

// ---------------------------------------------------------------------------------------------
// Campus impact (plan Section 5.6). The walking routes are precomputed, so the only thing that
// changes is a small, labelled nudge to the displayed occupancy of indoor dining and libraries.

const IMPACT: Partial<Record<Condition, { boost: number; note: string }>> = {
  drizzle: { boost: 0.05, note: 'Drizzle: a few more students stay indoors' },
  rain: { boost: 0.08, note: 'Rain: more students indoors; dining halls and libraries busier' },
  'heavy-rain': { boost: 0.1, note: 'Heavy rain: direct routes, more students indoors; dining and libraries busier' },
  snow: { boost: 0.1, note: 'Snow: slower walking, less lingering; dining and libraries busier' },
  thunderstorm: { boost: 0.12, note: 'Thunderstorm: students shelter indoors; dining and libraries busier' },
  heatwave: { boost: 0.06, note: 'Heatwave: fewer midday outdoor stays; air-conditioned libraries and dining busier' },
};

/** The one-line note for the Crowds tab, and the boost applied to dining and library activity. */
export function weatherImpact(condition: Condition): { note: string; boost: number } {
  const impact = IMPACT[condition];
  if (impact) return impact;
  if (condition === 'fog') return { note: 'Fog: campus routines unchanged', boost: 0 };
  return { note: 'No weather effect on campus routines', boost: 0 };
}

/** Boost dining and library color intensity while preserving the simulated population. */
export function adjustOccupancy(occupancy: Occupancy[], weather: ActiveWeather | null): Occupancy[] {
  const boost = weather ? weatherImpact(weather.condition).boost : 0;
  if (!boost) return occupancy;
  return occupancy.map((o) => {
    if (o.location.kind !== 'dining' && o.location.kind !== 'library') return o;
    return { ...o, share: o.share * (1 + boost) };
  });
}
