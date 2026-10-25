/*
 * The map's chrome: everything floating over the scene.
 *
 * Consolidated from one large right-hand sheet plus a wide bottom toolbar into
 * five pieces that each own a corner, so the map itself is the page and the
 * controls sit at its edges:
 *
 *   brand   top left      what this is
 *   rail    left edge     what is drawn on the map, one icon per layer
 *   tabs    top centre    what you are reading: Live, Log, Events, Analytics
 *   status  top right     the clock and the weather
 *   time    bottom left   play, speed, and whether the clock is live
 *   ask     bottom centre a question about the campus
 *
 * These are presentational. All state stays in App.tsx; nothing here owns the
 * simulation, and every control is a prop.
 */

import type { ReactNode } from 'react';

/* ---------------------------------------------------------------------------
 * Icons. One stroke weight, one size, currentColor throughout, so a button's
 * state is a colour change and never a different asset.
 * ------------------------------------------------------------------------- */
const svg = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

export const HudIcons = {
  campus: () => (
    <svg {...svg}>
      <path d="M9 4 3 6.5v13L9 17l6 2.5 6-2.5v-13L15 7z" />
      <path d="M9 4v13M15 7v12.5" />
    </svg>
  ),
  crowds: () => (
    <svg {...svg}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M16 6.2a3 3 0 0 1 0 5.6M17.5 19a5.4 5.4 0 0 0-2-4.2" />
    </svg>
  ),
  transit: () => (
    <svg {...svg}>
      <rect x="5" y="3" width="14" height="13" rx="3" />
      <path d="M5 11h14M8.5 19.5 7 17M15.5 19.5 17 17" />
      <circle cx="9" cy="13.5" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="15" cy="13.5" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  ),
  bikes: () => (
    <svg {...svg}>
      <circle cx="6" cy="16.5" r="3.5" />
      <circle cx="18" cy="16.5" r="3.5" />
      <path d="m6 16.5 4-8h5l3 8M10 8.5h5.5" />
    </svg>
  ),
  traffic: () => (
    <svg {...svg}>
      <path d="M12 3v18M5 7h14M5 12h14M5 17h14" />
    </svg>
  ),
  parking: () => (
    <svg {...svg}>
      <rect x="4" y="4" width="16" height="16" rx="4" />
      <path d="M10 16V8h2.6a2.7 2.7 0 0 1 0 5.4H10" />
    </svg>
  ),
  counts: () => (
    <svg {...svg}>
      <path d="M4 20V10M10 20V5M16 20v-7M22 20H2" />
    </svg>
  ),
  weather: () => (
    <svg {...svg}>
      <path d="M7 18h9.5a3.5 3.5 0 0 0 .5-6.96A5.5 5.5 0 0 0 6.6 10 4 4 0 0 0 7 18z" />
    </svg>
  ),
  incidents: () => (
    <svg {...svg}>
      <path d="M12 4 2.8 19.5h18.4z" />
      <path d="M12 10v4M12 17.2v.1" />
    </svg>
  ),
  layers: () => (
    <svg {...svg}>
      <path d="M12 3 3 8l9 5 9-5z" />
      <path d="M3 13l9 5 9-5" />
    </svg>
  ),
  play: ({ playing }: { playing: boolean }) => (
    <svg {...svg}>
      {playing ? <path d="M9 5v14M15 5v14" strokeWidth={2.2} /> : <path d="M7.5 4.8v14.4L19 12z" fill="currentColor" stroke="none" />}
    </svg>
  ),
  send: () => (
    <svg {...svg}>
      <path d="M5 12h13M13 6.5 18.5 12 13 17.5" />
    </svg>
  ),
  forward: () => (
    <svg {...svg}>
      <path d="M8 5.5v13L17 12z" fill="currentColor" stroke="none" />
    </svg>
  ),
  fastForward: () => (
    <svg {...svg}>
      <path d="M4 5.5v13L12 12z" fill="currentColor" stroke="none" />
      <path d="M12.5 5.5v13L20.5 12z" fill="currentColor" stroke="none" />
    </svg>
  ),
  search: () => (
    <svg {...svg}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </svg>
  ),
  close: () => (
    <svg {...svg}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  ),
};

/* ---------------------------------------------------------------------------
 * Brand
 * ------------------------------------------------------------------------- */
export function HudBrand({ name, context }: { name: string; context?: string }) {
  return (
    <div className="hud-brand">
      <img src="/favicon.svg" alt="" width={22} height={22} />
      <span className="hud-brand-name">{name}</span>
      {context && <span className="hud-brand-context">{context}</span>}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Left rail: what is drawn on the map.
 *
 * Each button is a toggle and says so: aria-pressed carries the state, and the
 * state is also a visible fill, never colour alone.
 * ------------------------------------------------------------------------- */
export interface RailItem {
  id: string;
  label: string;
  icon: ReactNode;
  /** Undefined for a button that opens something rather than toggling a layer. */
  on?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export function HudRail({ items }: { items: RailItem[] }) {
  return (
    <nav className="hud-rail" aria-label="Map layers">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="hud-rail-button"
          aria-label={item.label}
          aria-pressed={item.on}
          disabled={item.disabled}
          title={item.label}
          onClick={item.onSelect}
        >
          {item.icon}
        </button>
      ))}
    </nav>
  );
}

/* ---------------------------------------------------------------------------
 * Top tabs: what you are reading.
 * ------------------------------------------------------------------------- */
export interface HudTab<T extends string> {
  id: T;
  label: string;
}

export function HudTabs<T extends string>({
  tabs,
  active,
  onSelect,
}: {
  tabs: HudTab<T>[];
  /** null when every panel is closed and the map is uncovered. */
  active: T | null;
  onSelect: (id: T) => void;
}) {
  return (
    <div className="hud-tabs" role="tablist" aria-label="View">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          id={`hud-tab-${t.id}`}
          aria-selected={active === t.id}
          aria-controls={`hud-panel-${t.id}`}
          // With nothing open, the first tab is the one Tab reaches.
          tabIndex={active === t.id || (active === null && t === tabs[0]) ? 0 : -1}
          onClick={() => onSelect(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Top right: the clock and the weather.
 * ------------------------------------------------------------------------- */
/*
 * One block in the top right for everything about when.
 *
 * The reading sits on top -- the clock and the temperature, the two things you
 * glance at -- and everything that changes the time sits under it: the day, the
 * drag bar, and the transport. They were spread across two corners before, which
 * meant the control that moved the clock was nowhere near the clock.
 */
export function HudStatus({
  time,
  live,
  day,
  scrubber,
  controls,
  children,
}: {
  time: string;
  live: boolean;
  /** Which day of the week is being simulated. Part of the time, so it lives here. */
  day?: ReactNode;
  scrubber?: ReactNode;
  controls?: ReactNode;
  /** The weather chip, portalled in by WeatherControls. */
  children?: ReactNode;
}) {
  return (
    <div className="hud-status" role="group" aria-label="Time and weather">
      <div className="hud-status-reading">
        <output className="hud-clock" aria-live="off">
          {time}
        </output>
        {live && <span className="hud-live">Clock</span>}
        {children}
      </div>

      {(day || scrubber || controls) && (
        <div className="hud-status-controls">
          {day}
          {scrubber && <div className="hud-scrubber">{scrubber}</div>}
          {controls}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Bottom left: time.
 *
 * Small on purpose. The old bar ran the width of the screen for a play button, a
 * clock and five speeds; here the clock lives top right with the weather and this
 * keeps only what changes the simulation.
 * ------------------------------------------------------------------------- */
/*
 * Three buttons instead of a row of speed pills.
 *
 * The pills listed every speed the simulation can run at, which is a setting, not
 * a control: picking between 1x, 30x, 120x and 600x is not something you do while
 * watching. Play/pause is the control; forward steps up a speed and fast-forward
 * jumps to the fastest. The rate itself is shown on fast-forward so it is never a
 * mystery which one is running.
 */
export function HudTime({
  playing,
  onPlay,
  speed,
  speeds,
  onSpeed,
  live,
  onLive,
}: {
  playing: boolean;
  onPlay: () => void;
  speed: number;
  speeds: readonly number[];
  onSpeed: (s: number) => void;
  live: boolean;
  onLive: () => void;
}) {
  const at = speeds.indexOf(speed);
  const fastest = speeds[speeds.length - 1];
  const next = speeds[Math.min(at < 0 ? 1 : at + 1, speeds.length - 1)];
  const atFastest = speed === fastest;

  return (
    <div className="hud-time" role="group" aria-label="Time">
      <button
        type="button"
        className="hud-time-play"
        onClick={onPlay}
        aria-label={playing ? 'Pause' : 'Play'}
        title={playing ? 'Pause' : 'Play'}
      >
        <HudIcons.play playing={playing} />
      </button>

      <button
        type="button"
        className="hud-step"
        onClick={() => onSpeed(next)}
        disabled={atFastest}
        aria-label={`Faster, ${next} times real time`}
        title={`Faster · ${next}×`}
      >
        <HudIcons.forward />
      </button>

      <button
        type="button"
        className="hud-step"
        onClick={() => onSpeed(fastest)}
        aria-pressed={atFastest}
        aria-label={`Fastest, ${fastest} times real time`}
        title={`Fastest · ${fastest}×`}
      >
        <HudIcons.fastForward />
      </button>

      {/* The rate, only once it stops being real time. */}
      {!live && speed > 1 && <span className="hud-rate">{speed}×</span>}

      <button type="button" className="hud-live-toggle" aria-pressed={live} onClick={onLive} title="Follow Boston time and live transit">
        {live ? 'Live' : 'Go live'}
      </button>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Bottom centre: ask.
 * ------------------------------------------------------------------------- */
export function HudAsk({ children }: { children: ReactNode }) {
  return <div className="hud-ask">{children}</div>;
}

/* ---------------------------------------------------------------------------
 * Right panel.
 * ------------------------------------------------------------------------- */
export function HudPanel({
  id,
  title,
  onClose,
  children,
}: {
  id: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <aside className="hud-panel" id={`hud-panel-${id}`} role="tabpanel" aria-labelledby={`hud-tab-${id}`}>
      <header className="hud-panel-head">
        <h2>{title}</h2>
        <button type="button" className="hud-panel-close" onClick={onClose} aria-label={`Close ${title}`}>
          <HudIcons.close />
        </button>
      </header>
      <div className="hud-panel-body">{children}</div>
    </aside>
  );
}
