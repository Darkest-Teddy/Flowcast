// BU weather: the real conditions now (Open-Meteo, every 10 minutes), the hourly forecast for
// whatever time the clock shows (every 30 minutes), and simulated weather regimes.
// Rain and snow are deck.gl particles (src/weather/precipitation.ts, drawn by App's frame loop);
// fog and a wet or snowy ground go through the base map (Mapbox only); a light screen overlay
// (tint, distance haze, lightning) is drawn here so it also works on the MapLibre fallback.
// The readout and mode buttons are drawn into the sheet's Weather tab (`panel`), with a small
// temperature chip in the sheet's header (`chip`); the overlay stays here, over the map.
// Keyboard, while focus isn't in a form control: W cycles the weather.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Basemap, LightPreset } from './map/basemap';
import {
  FORECAST_REFRESH_MS,
  GROUND_BUILD_SECONDS,
  REFRESH_MS,
  RETRY_MS,
  WEATHER_MODES,
  activeWeather,
  cachedWeather,
  compass,
  fetchForecast,
  fetchWeather,
  forecastHours,
  hourLabel,
  mapWeather,
  nextMode,
  publishWeather,
  type ActiveWeather,
  type Condition,
  type Forecast,
  type WeatherEffect,
  type WeatherMode,
  type WeatherReading,
} from './weather/weather';

interface Props {
  basemap: Basemap | null;
  light: LightPreset;
  /** The time on the app's clock (seconds since midnight) and whether it is following real time. */
  simTime?: number | null;
  live?: boolean;
  onChange?: (weather: ActiveWeather) => void;
  /** Where the readout and mode buttons go (the Weather tab panel); nothing is drawn there without one. */
  panel?: HTMLElement | null;
  /** Where the header chip goes, and what pressing it does (open the Weather tab). */
  chip?: HTMLElement | null;
  onOpen?: () => void;
  /** A scenario's weather look (conditions engine); null/undefined leaves the control as set. */
  forceMode?: WeatherMode | null;
}

const clock = (iso: string | number) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Fetch now and every `every` ms; on failure keep the last value and retry in a minute. */
function usePolled<T>(load: (signal: AbortSignal) => Promise<T>, every: number, initial: T | null) {
  const [value, setValue] = useState<T | null>(initial);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let timer = 0;
    let disposed = false;
    let controller: AbortController | null = null;
    const run = async () => {
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 10_000);
      try {
        const next = await load(controller.signal);
        if (disposed) return;
        setValue(next);
        setError(null);
        timer = window.setTimeout(run, every);
      } catch (err) {
        if (disposed) return;
        setError(err instanceof Error && err.name !== 'AbortError' ? err.message : 'timed out');
        timer = window.setTimeout(run, RETRY_MS);
      } finally {
        window.clearTimeout(timeout);
      }
    };
    run();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      controller?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [value, error] as const;
}

export function WeatherControls({ basemap, light, simTime = null, live = true, onChange, panel = null, chip = null, onOpen, forceMode = null }: Props) {
  const [mode, setMode] = useState<WeatherMode>('live');
  // A scenario sets the look; leaving it goes back to live weather.
  const forced = useRef<WeatherMode | null>(null);
  useEffect(() => {
    if (forceMode) setMode(forceMode);
    else if (forced.current) setMode('live');
    forced.current = forceMode;
  }, [forceMode]);
  const [reading, error] = usePolled<WeatherReading>(fetchWeather, REFRESH_MS, cachedWeather()?.reading ?? null);
  const [forecast] = usePolled<Forecast>(fetchForecast, FORECAST_REFRESH_MS, null);

  // Recomputed once a simulated minute: temperature and wind glide between forecast hours.
  const minute = simTime == null ? null : Math.floor(simTime / 60);
  const active = useMemo(
    () => activeWeather(mode, reading, forecast, { live, seconds: minute == null ? null : minute * 60 }),
    [mode, reading, forecast, live, minute],
  );

  // The effect only changes identity when it actually looks different, so the map isn't redone
  // every minute and the ground keeps building up.
  const effectRef = useRef<{ key: string; effect: WeatherEffect } | null>(null);
  const effectKey = JSON.stringify(active.effect);
  if (effectRef.current?.key !== effectKey) effectRef.current = { key: effectKey, effect: active.effect };
  const effect = effectRef.current.effect;

  // The base map gets the fog, and a ground that soaks through (rain) or slowly whitens (snow).
  const groundRef = useRef<{ kind: string; start: number } | null>(null);
  useEffect(() => {
    if (!basemap) return;
    if (!effect.ground) {
      groundRef.current = null;
      basemap.setWeather(mapWeather(effect, 0));
      return;
    }
    if (groundRef.current?.kind !== effect.ground) groundRef.current = { kind: effect.ground, start: performance.now() };
    const { start } = groundRef.current;
    const seconds = GROUND_BUILD_SECONDS[effect.ground];
    const step = () => basemap.setWeather(mapWeather(effect, (performance.now() - start) / 1000 / seconds));
    step();
    const timer = window.setInterval(() => {
      step();
      if (performance.now() - start > seconds * 1000) window.clearInterval(timer);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [basemap, effect]);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    publishWeather(active);
    onChangeRef.current?.(active);
  }, [active]);

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

  const flashRef = useLightning(effect.overlay.lightning);
  const { tint, haze, hazeTone } = effect.overlay;
  const dark = light === 'dusk' || light === 'night';

  const windText = `${compass(active.wind.fromDeg)} wind ${Math.round(active.wind.mph)} mph`;
  let detail: string;
  if (active.source === 'live') {
    detail = error
      ? `As of ${clock(reading!.observedAt)} · offline, retrying`
      : `Feels ${Math.round(active.feelsLikeF!)}° · ${windText} · ${clock(reading!.observedAt)}`;
  } else if (active.source === 'forecast') {
    detail = `${active.when} · feels ${Math.round(active.feelsLikeF!)}° · ${windText}`;
  } else if (active.source === 'simulated') {
    detail = reading ? `Actual now: ${Math.round(reading.temperatureF)}°F, ${reading.text.toLowerCase()}` : 'Not the real weather';
  } else {
    detail = error ? 'Open-Meteo unreachable · retrying' : 'Fetching Boston weather…';
  }

  // The next hours from the time on the clock (the shown hour first).
  const nowSeconds = live || simTime == null ? new Date().getHours() * 3600 : simTime;
  const strip = forecast ? forecastHours(forecast, nowSeconds, 6) : [];
  const badge = { live: 'LIVE', forecast: 'FORECAST', simulated: 'SIMULATED', none: 'NO DATA' }[active.source];

  return (
    <>
      <div className="weather-sky" aria-hidden="true">
        <div className="weather-tint" style={{ backgroundColor: tint ?? '#ffffff' }} />
        <div className={`weather-haze ${hazeTone}${dark ? ' dark' : ''}`} style={{ opacity: haze }} />
        <div className="weather-flash" ref={flashRef} />
      </div>

      {panel && createPortal(
        <section className="weather" aria-label="Weather">
          <div className="weather-readout" role="status">
            <WeatherIcon condition={active.condition} size={30} />
            <strong className="weather-temp">{active.temperatureF == null ? '—' : `${Math.round(active.temperatureF)}°F`}</strong>
            <span className="weather-text">
              <span className="weather-condition">{active.text}</span>
              <span className={`badge ${active.source === 'live' ? 'live-badge' : active.source === 'forecast' ? 'forecast-badge' : 'sim-badge'}`}>{badge}</span>
            </span>
          </div>
          <p className="weather-detail">{detail}</p>
          {strip.length > 0 && (
            <ol className="weather-hours" aria-label="Hourly forecast">
              {strip.map(({ hour, reading: r }, i) => (
                <li key={hour} className={i === 0 ? 'current' : undefined}>
                  <span className="weather-hour">{hourLabel(hour).replace(' ', '')}</span>
                  <WeatherIcon condition={r.condition} size={16} />
                  <span>{Math.round(r.temperatureF)}°</span>
                </li>
              ))}
            </ol>
          )}
          <div className="weather-modes" role="group" aria-label="Weather">
            {WEATHER_MODES.map((m) => (
              <button key={m.mode} onClick={() => setMode(m.mode)} aria-pressed={mode === m.mode} title={m.title} className={m.mode === 'live' ? 'span-2' : undefined}>
                {m.mode === 'live' ? <span className="live-dot" aria-hidden="true" /> : <WeatherIcon condition={MODE_ICON[m.mode]} size={18} />}
                {m.label}
              </button>
            ))}
          </div>
          <p className="weather-hint">W cycles · data: Open-Meteo</p>
        </section>,
        panel,
      )}
      {chip && createPortal(
        <button className="weather-chip" onClick={onOpen} aria-label={`Weather: ${active.temperatureF == null ? 'no reading' : `${Math.round(active.temperatureF)}°F`}, ${active.text}. Show weather`} title="Weather (W cycles)">
          <WeatherIcon condition={active.condition} size={18} />
          {active.temperatureF == null ? '—' : `${Math.round(active.temperatureF)}°`}
        </button>,
        chip,
      )}
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
