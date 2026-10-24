// Live BU weather (Open-Meteo, refreshed every 10 minutes) and simulated weather regimes.
// Rain, snow and fog go through the base map (Mapbox v3 only); a light screen overlay (tint,
// distance haze, lightning) is drawn here so it also works on the MapLibre fallback.
// Keyboard, while focus isn't in a form control: W cycles the weather.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Basemap, LightPreset } from './map/basemap';
import {
  REFRESH_MS,
  RETRY_MS,
  WEATHER_MODES,
  activeWeather,
  cachedWeather,
  compass,
  fetchWeather,
  nextMode,
  type ActiveWeather,
  type Condition,
  type WeatherMode,
  type WeatherReading,
} from './weather/weather';

interface Props {
  basemap: Basemap | null;
  light: LightPreset;
  onChange?: (weather: ActiveWeather) => void;
}

const clock = (iso: string | number) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function WeatherControls({ basemap, light, onChange }: Props) {
  const [mode, setMode] = useState<WeatherMode>('live');
  const [reading, setReading] = useState<WeatherReading | null>(() => cachedWeather()?.reading ?? null);
  const [error, setError] = useState<string | null>(null);

  // Live readings: now, then every 10 minutes; a failure keeps the last reading and retries in a minute.
  useEffect(() => {
    let timer = 0;
    let disposed = false;
    let controller: AbortController | null = null;
    const load = async () => {
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 10_000);
      try {
        const next = await fetchWeather(controller.signal);
        if (disposed) return;
        setReading(next);
        setError(null);
        timer = window.setTimeout(load, REFRESH_MS);
      } catch (err) {
        if (disposed) return;
        setError(err instanceof Error && err.name !== 'AbortError' ? err.message : 'timed out');
        timer = window.setTimeout(load, RETRY_MS);
      } finally {
        window.clearTimeout(timeout);
      }
    };
    load();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      controller?.abort();
    };
  }, []);

  const active = useMemo(() => activeWeather(mode, reading), [mode, reading]);

  useEffect(() => {
    basemap?.setWeather(active.effect);
  }, [basemap, active]);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => onChangeRef.current?.(active), [active]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName))) return;
      if (e.key !== 'w' && e.key !== 'W') return;
      e.preventDefault();
      setMode((m) => nextMode(m));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const flashRef = useLightning(active.effect.overlay.lightning);
  const { tint, haze, hazeTone } = active.effect.overlay;
  const dark = light === 'dusk' || light === 'night';

  let detail: string;
  if (active.mode === 'live') {
    detail = reading
      ? `Feels ${Math.round(reading.feelsLikeF)}° · ${compass(reading.windFromDeg)} wind ${Math.round(reading.windMph)} mph · ${clock(reading.observedAt)}`
      : error
        ? 'Open-Meteo unreachable · retrying'
        : 'Fetching Boston weather…';
    if (reading && error) detail = `As of ${clock(reading.observedAt)} · offline, retrying`;
  } else {
    detail = reading ? `Actual now: ${Math.round(reading.temperatureF)}°F, ${reading.text.toLowerCase()}` : 'Not the real weather';
  }

  return (
    <>
      <div className="weather-sky" aria-hidden="true">
        <div className="weather-tint" style={{ backgroundColor: tint ?? '#ffffff' }} />
        <div className={`weather-haze ${hazeTone}${dark ? ' dark' : ''}`} style={{ opacity: haze }} />
        <div className="weather-flash" ref={flashRef} />
      </div>

      <section className="panel weather" aria-label="Weather">
        <div className="weather-readout" role="status">
          <WeatherIcon condition={active.condition} size={30} />
          <strong className="weather-temp">{active.temperatureF == null ? '—' : `${Math.round(active.temperatureF)}°F`}</strong>
          <span className="weather-text">
            <span className="weather-condition">{active.text}</span>
            {active.live ? (
              <span className="live-badge">LIVE</span>
            ) : (
              <span className="sim-badge">{active.mode === 'live' ? 'NO DATA' : 'SIMULATED'}</span>
            )}
          </span>
        </div>
        <p className="weather-detail">{detail}</p>
        <div className="weather-modes" role="group" aria-label="Weather">
          {WEATHER_MODES.map((m) => (
            <button key={m.mode} onClick={() => setMode(m.mode)} aria-pressed={mode === m.mode} title={m.title} className={m.mode === 'live' ? 'span-2' : undefined}>
              {m.mode === 'live' ? <span className="live-dot" aria-hidden="true" /> : <WeatherIcon condition={MODE_ICON[m.mode]} size={18} />}
              {m.label}
            </button>
          ))}
        </div>
        <p className="weather-hint">W cycles · live data: Open-Meteo</p>
      </section>
    </>
  );
}

const MODE_ICON: Record<Exclude<WeatherMode, 'live'>, Condition> = {
  clear: 'clear',
  rain: 'rain',
  snow: 'snow',
  fog: 'fog',
  thunderstorm: 'thunderstorm',
  heatwave: 'heatwave',
};

/**
 * Occasional lightning: a soft double flicker every 5 to 13 seconds, never more than two flashes
 * a second (well under the WCAG three-flash limit), and none at all under prefers-reduced-motion.
 */
function useLightning(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!enabled || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let timer = 0;
    const strike = () => {
      ref.current?.animate(
        [
          { opacity: 0 },
          { opacity: 0.38, offset: 0.08 },
          { opacity: 0.06, offset: 0.25 },
          { opacity: 0.26, offset: 0.4 },
          { opacity: 0 },
        ],
        { duration: 900, easing: 'ease-out' },
      );
      timer = window.setTimeout(strike, 5000 + Math.random() * 8000);
    };
    timer = window.setTimeout(strike, 1200);
    return () => window.clearTimeout(timer);
  }, [enabled]);
  return ref;
}

/** Small line icons, drawn in currentColor. */
function WeatherIcon({ condition, size }: { condition: Condition; size: number }) {
  const cloud = <path d="M7 18h10a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7.1 9.2 4.4 4.4 0 0 0 7 18z" />;
  const smallCloud = <path d="M7 15h9a3.4 3.4 0 0 0 .5-6.76A4.7 4.7 0 0 0 7.6 7.1 3.95 3.95 0 0 0 7 15z" />;
  let body: ReactNode;
  switch (condition) {
    case 'clear':
      body = (
        <>
          <circle cx="12" cy="12" r="4.2" />
          <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" />
        </>
      );
      break;
    case 'partly-cloudy':
      body = (
        <>
          <path d="M9 3.5v1.6M3.5 9h1.6M5.1 5.1l1.1 1.1M12.9 5.1l-1.1 1.1M6.3 11.2A3.2 3.2 0 1 1 11.6 7.6" />
          <path d="M9 20h8.5a3.5 3.5 0 0 0 .5-6.96A4.8 4.8 0 0 0 9.2 12a3.95 3.95 0 0 0-.2 8z" />
        </>
      );
      break;
    case 'cloudy':
      body = cloud;
      break;
    case 'fog':
      body = (
        <>
          <path d="M7 12h10a3.5 3.5 0 0 0 .2-7A4.8 4.8 0 0 0 7.6 4.6 3.7 3.7 0 0 0 7 12z" />
          <path d="M4 15.5h16M6 19h12M8 22h8" />
        </>
      );
      break;
    case 'drizzle':
    case 'rain':
    case 'heavy-rain':
      body = (
        <>
          {smallCloud}
          <path d={condition === 'drizzle' ? 'M9 18.5v1M13 18.5v1M17 18.5v1' : 'M8.5 18l-1 3M12.5 18l-1 3M16.5 18l-1 3'} />
        </>
      );
      break;
    case 'snow':
      body = (
        <>
          {smallCloud}
          <path d="M8.5 19.5h.01M12.5 18.5h.01M16.5 19.5h.01M10.5 22h.01M14.5 22h.01" strokeWidth={2.6} />
        </>
      );
      break;
    case 'thunderstorm':
      body = (
        <>
          {smallCloud}
          <path d="M12.5 15.5l-2.5 3.5h3l-2 3.5" />
        </>
      );
      break;
    case 'heatwave':
      body = (
        <>
          <circle cx="12" cy="9" r="3.6" />
          <path d="M12 2.2v1.6M5.2 9H3.6M20.4 9h-1.6M7.2 4.2l1.1 1.1M16.8 4.2l-1.1 1.1" />
          <path d="M4 16c1.3-1 2.7-1 4 0s2.7 1 4 0 2.7-1 4 0 2.7 1 4 0M4 20c1.3-1 2.7-1 4 0s2.7 1 4 0 2.7-1 4 0 2.7 1 4 0" />
        </>
      );
      break;
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="weather-icon">
      {body}
    </svg>
  );
}
