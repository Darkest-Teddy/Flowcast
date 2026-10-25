// Weather for BU: live conditions and the hourly forecast from Open-Meteo (free, no key,
// CORS-open), what each condition looks like on the map (deck.gl rain and snow, Mapbox fog and
// ground colours, a light screen tint), and the small, clearly-labelled campus impact from plan
// Section 5.6 ("rain favours indoor destinations").
import type { Occupancy } from '../sim/playback';
import type { Precipitation } from './precipitation';

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
  { mode: 'live', label: 'Source', title: 'Open-Meteo current conditions or hourly weather for the selected date, when available' },
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
  precipMmPerHour: number; // rain and snow, as a rate
  snowCmPerHour: number;
  cloudCover: number; // %
  windMph: number;
  windFromDeg: number; // meteorological: where the wind comes from
  visibilityM: number;
  isDay: boolean;
  observedAt: string; // Boston local time of the observation or forecast hour, "2026-10-24T12:15"
}

/** Where the shown weather comes from. */
export type WeatherSource = 'live' | 'forecast' | 'simulated' | 'none';

/** What the map and panel show right now. */
export interface ActiveWeather {
  mode: WeatherMode;
  source: WeatherSource;
  live: boolean; // true: real current conditions
  /** For the panel: "Live weather", "Forecast for 3 PM", "Simulated weather". */
  sourceLabel: string;
  /** For a forecast: "Forecast 3 PM", "Earlier today 9 AM". */
  when: string | null;
  condition: Condition;
  text: string;
  temperatureF: number | null;
  feelsLikeF: number | null;
  wind: { fromDeg: number; mph: number };
  reading: WeatherReading | null; // the latest real reading, if any, even while simulating
  effect: WeatherEffect;
}

type Spec = Record<string, unknown>;

export interface WeatherEffect {
  /** Mapbox fog spec, merged into the base map's distance haze; null keeps just the haze. */
  fog: Spec | null;
  /** World-space rain or snow particles (deck.gl, so on either map). */
  precipitation: Precipitation | null;
  /** The ground: wet and darker in rain, a dusting of snow that builds up. Mapbox only. */
  ground: 'wet' | 'snow' | null;
  /** Screen overlay drawn by WeatherControls over either map. */
  overlay: {
    tint: string | null; // multiplied over the map: dims and colours the light
    haze: number; // 0..1 strength of a distance haze, thicker toward the horizon
    hazeTone: 'cool' | 'warm';
    lightning: boolean;
  };
}

/** What the base map is given: fog, and the ground at its current build-up. */
export interface MapWeather {
  fog: Spec | null;
  ground: { colors: Record<string, string>; roofSnow: number } | null;
}

const API_URL =
  'https://api.open-meteo.com/v1/forecast?latitude=42.3505&longitude=-71.1054' +
  '&current=temperature_2m,apparent_temperature,precipitation,rain,snowfall,weather_code,cloud_cover,' +
  'wind_speed_10m,wind_direction_10m,visibility,is_day' +
  '&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FNew_York';
const FORECAST_URL =
  'https://api.open-meteo.com/v1/forecast?latitude=42.3505&longitude=-71.1054' +
  '&hourly=temperature_2m,apparent_temperature,precipitation,rain,snowfall,weather_code,cloud_cover,' +
  'wind_speed_10m,wind_direction_10m,visibility,is_day' +
  '&past_days=1&forecast_days=2' +
  '&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FNew_York';

export const REFRESH_MS = 10 * 60_000;
export const FORECAST_REFRESH_MS = 30 * 60_000;
export const RETRY_MS = 60_000;
const CACHE_KEY = 'flowcast.weather.v2';
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

/** One set of Open-Meteo values as a reading. `hours` is the period precipitation is summed over. */
function toReading(v: Record<string, number>, time: string, hours: number): WeatherReading {
  const required = ['weather_code', 'temperature_2m', 'apparent_temperature', 'precipitation', 'snowfall', 'cloud_cover', 'wind_speed_10m', 'wind_direction_10m', 'visibility', 'is_day'];
  if (!required.every((key) => typeof v[key] === 'number' && Number.isFinite(v[key]))
    || !WMO[v.weather_code] || !Number.isFinite(hours) || hours <= 0
    || typeof time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(time)) {
    throw new Error('Open-Meteo: incomplete weather reading');
  }
  const [condition, text] = describeCode(v.weather_code);
  const reading: WeatherReading = {
    code: v.weather_code,
    condition,
    text,
    temperatureF: v.temperature_2m,
    feelsLikeF: v.apparent_temperature,
    precipMmPerHour: v.precipitation / hours,
    snowCmPerHour: v.snowfall / hours,
    cloudCover: v.cloud_cover,
    windMph: v.wind_speed_10m,
    windFromDeg: v.wind_direction_10m,
    visibilityM: v.visibility,
    isDay: v.is_day === 1,
    observedAt: time,
  };
  // A real heatwave shows as one (clear skies at 90°F+ "feels like").
  if ((condition === 'clear' || condition === 'partly-cloudy') && reading.feelsLikeF >= 90) {
    reading.condition = 'heatwave';
    reading.text = `Hot · ${text.toLowerCase()}`;
  }
  return reading;
}

/** Fetch the current BU conditions. Throws on network or API failure. */
export async function fetchWeather(signal?: AbortSignal): Promise<WeatherReading> {
  const res = await fetch(API_URL, { signal, cache: 'no-store' });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const c = (await res.json()).current;
  if (!c || typeof c.weather_code !== 'number') throw new Error('Open-Meteo: no current conditions');
  const reading = toReading(c, c.time, (c.interval ?? 900) / 3600); // "current" sums the last 15 minutes
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), reading }));
  } catch {
    /* private mode */
  }
  return reading;
}

/** Hourly readings from yesterday to tomorrow, keyed by Boston local time ("2026-10-24T15:00"). */
export type Forecast = Map<string, WeatherReading>;

export async function fetchForecast(signal?: AbortSignal): Promise<Forecast> {
  const res = await fetch(FORECAST_URL, { signal, cache: 'no-store' });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const h = (await res.json()).hourly;
  if (!h?.time?.length) throw new Error('Open-Meteo: no hourly forecast');
  const keys = Object.keys(h).filter((k) => k !== 'time');
  const out: Forecast = new Map();
  h.time.forEach((time: string, i: number) => {
    if (typeof h.weather_code[i] !== 'number') return;
    out.set(time, toReading(Object.fromEntries(keys.map((k) => [k, h[k][i]])), time, 1));
  });
  return out;
}

export const bostonDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d); // YYYY-MM-DD
/** Current readings expire by their source time, even after a successful repeat poll. */
export function freshWeather(reading: WeatherReading | null, now = new Date()): boolean {
  if (!reading) return false;
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(now);
  const age = Date.parse(parts.replace(' ', 'T') + 'Z') - Date.parse(reading.observedAt + 'Z');
  return Number.isFinite(age) && age >= 0 && age <= 30 * 60_000;
}
const nextDate = (date: string, days = 1) => new Date(Date.parse(date + 'T12:00:00Z') + days * 86_400_000).toISOString().slice(0, 10);
const hourKey = (date: string, hour: number) => `${date}T${String(hour).padStart(2, '0')}:00`;
export const hourLabel = (hour: number) => `${hour % 12 || 12} ${hour < 12 ? 'AM' : 'PM'}`;

/**
 * The selected date's forecast at a time of day (seconds since midnight). The condition switches at hour
 * boundaries; temperature and wind are interpolated between hours.
 */
export function forecastAt(forecast: Forecast, seconds: number, date = bostonDate()): WeatherReading | null {
  const hour = Math.min(23, Math.max(0, Math.floor(seconds / 3600)));
  const at = forecast.get(hourKey(date, hour));
  if (!at) return null;
  const next = hour < 23 ? forecast.get(hourKey(date, hour + 1)) : forecast.get(hourKey(nextDate(date), 0));
  if (!next) return at;
  const f = Math.min(1, Math.max(0, seconds / 3600 - hour));
  const lerp = (a: number, b: number) => a + (b - a) * f;
  const turn = ((((next.windFromDeg - at.windFromDeg) % 360) + 540) % 360) - 180; // the short way round
  return {
    ...at,
    temperatureF: lerp(at.temperatureF, next.temperatureF),
    feelsLikeF: lerp(at.feelsLikeF, next.feelsLikeF),
    windMph: lerp(at.windMph, next.windMph),
    windFromDeg: (at.windFromDeg + turn * f + 360) % 360,
  };
}

/** The forecast hours from a time of day on: for the hourly strip. */
export function forecastHours(forecast: Forecast, seconds: number, count: number, selectedDate = bostonDate()): { hour: number; reading: WeatherReading }[] {
  const out: { hour: number; reading: WeatherReading }[] = [];
  const start = Math.floor(seconds / 3600);
  for (let i = 0; i < count; i++) {
    const h = start + i;
    const date = nextDate(selectedDate, Math.floor(h / 24));
    const reading = forecast.get(hourKey(date, h % 24));
    if (reading) out.push({ hour: h % 24, reading });
  }
  return out;
}

/** The last good reading from this browser, if recent: keeps Live honest through a venue Wi-Fi blip on reload. */
export function cachedWeather(): { reading: WeatherReading; at: number } | null {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null');
    if (cached && Number.isFinite(cached.at) && Date.now() >= cached.at && Date.now() - cached.at < CACHE_MAX_AGE_MS && freshWeather(cached.reading)) return cached;
  } catch {
    /* ignore */
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Effects

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// Colours that follow the light: Standard's "brightness" is ~0.1 at night and ~0.45 at midday,
// so the same fog reads as pale haze by day and dark murk at dusk.
const byLight = (dark: string, light: string) => ['interpolate', ['linear'], ['measure-light', 'brightness'], 0.1, dark, 0.4, light];

const FADE = { duration: 1500, delay: 0 };

// Ranges stay within the base map's distance haze ([0.8, 3.2]), which basemap.ts merges these into.
function fog(range: [number, number], dark: string, light: string, highDark: string, highLight: string, horizonBlend?: number): Spec {
  return {
    range,
    color: byLight(dark, light),
    'high-color': byLight(highDark, highLight),
    'space-color': byLight(highDark, highLight),
    ...(horizonBlend === undefined ? {} : { 'horizon-blend': horizonBlend }),
    'star-intensity': 0,
    // A short cross-fade when the weather changes (e.g. at an hour boundary when playing back).
    'range-transition': FADE,
    'color-transition': FADE,
    'high-color-transition': FADE,
  };
}

const NO_OVERLAY: WeatherEffect['overlay'] = { tint: null, haze: 0, hazeTone: 'cool', lightning: false };

function precipitation(kind: Precipitation['kind'], strength: number, wind: { fromDeg: number; mph: number }): Precipitation {
  return { kind, strength, windToDeg: (wind.fromDeg + 180) % 360, windMph: wind.mph };
}

/** What a condition looks like. `strength` (0..1) scales precipitation; Live derives it from the measured amount. */
export function effectFor(condition: Condition, strength: number, wind: { fromDeg: number; mph: number }): WeatherEffect {
  const s = clamp(strength, 0, 1);
  const dry = { precipitation: null, ground: null };
  switch (condition) {
    case 'clear':
    case 'partly-cloudy':
      return { ...dry, fog: null, overlay: NO_OVERLAY };
    case 'cloudy':
      return {
        ...dry,
        // Overcast: a soft blue-grey sky rather than flat grey (the sky colours come from fog).
        fog: fog([0.6, 3.2], 'hsl(220, 14%, 22%)', 'hsl(212, 20%, 84%)', 'hsl(220, 18%, 16%)', 'hsl(212, 30%, 66%)'),
        overlay: { tint: '#dde2ea', haze: 0.15, hazeTone: 'cool', lightning: false },
      };
    case 'fog':
      return {
        ...dry,
        fog: fog([-0.6, 1.6], 'hsl(220, 10%, 40%)', 'hsl(210, 10%, 86%)', 'hsl(220, 10%, 34%)', 'hsl(210, 10%, 82%)', 0.3),
        overlay: { tint: '#e6e9ee', haze: 0.55, hazeTone: 'cool', lightning: false },
      };
    // Rain and snow keep the map crisp: the mood comes from the particles and the ground.
    case 'drizzle':
    case 'rain':
    case 'heavy-rain':
      return {
        precipitation: precipitation('rain', s, wind),
        ground: 'wet',
        fog: fog([0.5, 3.2], 'hsl(220, 16%, 18%)', 'hsl(212, 12%, 80%)', 'hsl(220, 18%, 15%)', 'hsl(212, 14%, 74%)'),
        overlay: { tint: s > 0.6 ? '#eceff4' : '#f2f4f7', haze: 0.06 + 0.08 * s, hazeTone: 'cool', lightning: false },
      };
    case 'snow':
      return {
        precipitation: precipitation('snow', s, wind),
        ground: 'snow',
        fog: fog([0.4, 3], 'hsl(220, 12%, 30%)', 'hsl(210, 22%, 92%)', 'hsl(220, 14%, 26%)', 'hsl(210, 22%, 88%)'),
        overlay: { tint: null, haze: 0.1 + 0.08 * s, hazeTone: 'cool', lightning: false },
      };
    case 'thunderstorm':
      return {
        precipitation: precipitation('rain', Math.max(s, 0.85), { fromDeg: wind.fromDeg, mph: Math.max(wind.mph, 12) }),
        ground: 'wet',
        fog: fog([0.3, 2.8], 'hsl(225, 20%, 12%)', 'hsl(218, 12%, 54%)', 'hsl(225, 22%, 10%)', 'hsl(218, 14%, 48%)'),
        overlay: { tint: '#c2c9d5', haze: 0.22, hazeTone: 'cool', lightning: true },
      };
    case 'heatwave':
      return {
        ...dry,
        fog: fog([0.3, 3], 'hsl(25, 30%, 24%)', 'hsl(36, 70%, 82%)', 'hsl(25, 34%, 20%)', 'hsl(32, 70%, 78%)', 0.3),
        overlay: { tint: '#fff4e8', haze: 0.28, hazeTone: 'warm', lightning: false },
      };
  }
}

// Mapbox Standard's ground colours: its defaults, and how they look soaked or under snow.
type Hsl = [number, number, number];
const GROUND: Record<string, { dry: Hsl; wet: Hsl; snow: Hsl }> = {
  colorLand: { dry: [20, 20, 95], wet: [215, 10, 84], snow: [210, 30, 97] },
  colorGreenspace: { dry: [115, 60, 84], wet: [125, 36, 70], snow: [190, 22, 93] },
  colorEducation: { dry: [40, 50, 88], wet: [35, 22, 80], snow: [210, 24, 95] },
  colorCommercial: { dry: [24, 100, 94], wet: [24, 28, 84], snow: [210, 24, 95] },
  colorMedical: { dry: [0, 50, 92], wet: [0, 22, 84], snow: [210, 24, 95] },
  colorIndustrial: { dry: [230, 15, 92], wet: [225, 12, 82], snow: [210, 24, 95] },
  colorRoads: { dry: [224, 25, 80], wet: [222, 20, 64], snow: [218, 16, 85] },
  colorMotorways: { dry: [214, 23, 70], wet: [214, 20, 56], snow: [214, 14, 79] },
  colorTrunks: { dry: [235, 20, 70], wet: [230, 18, 58], snow: [225, 14, 80] },
};
/** Seconds for the ground to soak through, or for snow to settle. */
export const GROUND_BUILD_SECONDS = { wet: 20, snow: 60 };

function mixHsl(a: Hsl, b: Hsl, f: number): string {
  const dh = ((((b[0] - a[0]) % 360) + 540) % 360) - 180; // the short way round
  const h = (a[0] + dh * f + 360) % 360;
  return `hsl(${h.toFixed(1)}, ${(a[1] + (b[1] - a[1]) * f).toFixed(1)}%, ${(a[2] + (b[2] - a[2]) * f).toFixed(1)}%)`;
}

/** The base map's share of an effect, with the ground `cover` (0..1) of the way to soaked or snowed-in. */
export function mapWeather(effect: WeatherEffect, cover: number): MapWeather {
  const kind = effect.ground;
  if (!kind || cover <= 0) return { fog: effect.fog, ground: null };
  const f = clamp(cover, 0, 1);
  const colors = Object.fromEntries(Object.entries(GROUND).map(([key, c]) => [key, mixHsl(c.dry, c[kind], f)]));
  return { fog: effect.fog, ground: { colors, roofSnow: kind === 'snow' ? f : 0 } };
}

/** Precipitation strength (0..1) from a real reading: measured rate where there is one, else the code's wording. */
function liveStrength(r: WeatherReading): number {
  if (r.condition === 'snow') {
    const cmPerHour = r.snowCmPerHour;
    const fromCode = r.code === 71 || r.code === 77 ? 0.25 : r.code === 75 || r.code === 86 ? 0.85 : 0.5;
    return cmPerHour > 0 ? clamp(Math.sqrt(cmPerHour / 3), 0.15, 1) : fromCode;
  }
  const mmPerHour = r.precipMmPerHour;
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

/** What to show: a manual regime, the real weather now (Live), or the forecast for the shown time (playback). */
export function activeWeather(
  mode: WeatherMode,
  reading: WeatherReading | null,
  forecast: Forecast | null,
  clock: { live: boolean; seconds: number | null; date?: string },
): ActiveWeather {
  if (!freshWeather(reading)) reading = null;
  if (mode !== 'live') {
    const sim = SIMULATED[mode];
    const wind = reading ? { fromDeg: reading.windFromDeg, mph: reading.windMph } : { fromDeg: 250, mph: 8 };
    return {
      mode,
      source: 'simulated',
      live: false,
      sourceLabel: 'Simulated weather',
      when: null,
      condition: sim.condition,
      text: sim.text,
      temperatureF: sim.temperatureF,
      feelsLikeF: null,
      wind,
      reading,
      effect: effectFor(sim.condition, sim.strength, wind),
    };
  }
  // A missing reference-date hour must not fall back to today's current conditions.
  const date = clock.date ?? bostonDate();
  const shown = clock.live ? reading : forecast && clock.seconds != null ? forecastAt(forecast, clock.seconds, date) : null;
  const source: WeatherSource = shown ? clock.live ? 'live' : 'forecast' : 'none';
  const when = source === 'forecast' ? `Hourly weather ${date} ${hourLabel(Math.floor(clock.seconds! / 3600))}` : null;
  if (!shown) {
    const wind = { fromDeg: 250, mph: 8 };
    return {
      mode,
      source: 'none',
      live: false,
      sourceLabel: 'No weather data',
      when: null,
      condition: 'clear',
      text: clock.live ? 'Current weather unavailable' : `Weather unavailable for ${date}`,
      temperatureF: null,
      feelsLikeF: null,
      wind,
      reading,
      effect: effectFor('clear', 0, wind),
    };
  }
  // The map treats a lot of cloud as overcast even when the code says "partly".
  const condition = shown.condition === 'partly-cloudy' && shown.cloudCover >= 85 ? 'cloudy' : shown.condition;
  const wind = { fromDeg: shown.windFromDeg, mph: shown.windMph };
  return {
    mode,
    source,
    live: source === 'live',
    sourceLabel: source === 'forecast' ? when! : 'Live weather',
    when,
    condition,
    text: shown.text,
    temperatureF: shown.temperatureF,
    feelsLikeF: shown.feelsLikeF,
    wind,
    reading: shown,
    effect: effectFor(condition, liveStrength(shown), wind),
  };
}

// The wind of whatever weather is showing, for anything that sways or sails (boats, flags).
let currentWind: { fromDeg: number; mph: number } | null = null;
/** Called by WeatherControls whenever the shown weather changes. */
export function publishWeather(weather: ActiveWeather) {
  currentWind = weather.source === 'none' ? null : weather.wind;
}
/** Where the shown weather's wind comes from (meteorological degrees, 0 = from the north), or null before any weather is known. */
export const activeWindFromDegrees = (): number | null => currentWind?.fromDeg ?? null;
/** The shown weather's wind speed in mph, or null before any weather is known. */
export const activeWindMph = (): number | null => currentWind?.mph ?? null;

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
