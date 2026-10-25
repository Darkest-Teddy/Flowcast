/*
 * The map's chrome: everything floating over the scene.
 *
 * Consolidated from one large right-hand sheet plus a wide bottom toolbar into
 * pieces that each own a zone, so the map itself is the page and the controls
 * sit at its edges (hud.css lays them out):
 *
 *   brand   top left      what this is
 *   rail    under brand   what is drawn on the map, one icon per layer
 *   tabs    top centre    what you are reading: Analytics, Events, Log
 *   status  top right     the clock and the weather, and under them the day,
 *                         the drag bar, play, speed and whether the clock is live
 *   legend  bottom left   what the crowd colours mean
 *   ask     bottom centre a question about the campus
 *
 * These are presentational. All state stays in App.tsx; nothing here owns the
 * simulation, and every control is a prop.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
/* Type only: the modes belong to the tag layer that implements them, and the
   rail's menu must offer exactly those three. No runtime dependency. */
import { MARK_PATH, MARK_VIEWBOX } from '../../../theme/mark';

/* ---------------------------------------------------------------------------
 * Icons. One stroke weight, one size, currentColor throughout, so a button's
 * state is a colour change and never a different asset.
 * ------------------------------------------------------------------------- */
const svg = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

/* Two people: the crowds glyph the left rail has always used, and the Busy level's mark. One icon,
   two names, so the rail and the crowd scale can never drift apart. */
const Person2 = () => (
  <svg {...svg}>
    <circle cx="9" cy="8" r="3" />
    <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
    <path d="M16 6.2a3 3 0 0 1 0 5.6M17.5 19a5.4 5.4 0 0 0-2-4.2" />
  </svg>
);

export const HudIcons = {
  campus: () => (
    <svg {...svg}>
      <path d="M9 4 3 6.5v13L9 17l6 2.5 6-2.5v-13L15 7z" />
      <path d="M9 4v13M15 7v12.5" />
    </svg>
  ),
  crowds: Person2,
  /* The crowd levels' marks: Quiet, Busy, Packed (theme/crowd.ts names them). */
  person1: () => (
    <svg {...svg}>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </svg>
  ),
  person2: Person2,
  person3: () => (
    <svg {...svg}>
      <circle cx="12" cy="7.5" r="2.8" />
      <path d="M7 19.5a5 5 0 0 1 10 0" />
      <circle cx="5" cy="9.5" r="2.1" />
      <path d="M1.5 18.5a4 4 0 0 1 4.5-4" />
      <circle cx="19" cy="9.5" r="2.1" />
      <path d="M22.5 18.5a4 4 0 0 0-4.5-4" />
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
  /* The campus calendar: events, both as a layer and as a tab. */
  calendar: () => (
    <svg {...svg}>
      <rect x="3.5" y="5" width="17" height="15.5" rx="3" />
      <path d="M3.5 10h17M8.5 3.5V7M15.5 3.5V7" />
    </svg>
  ),
  /* Beside the time, so the reading says what it is with no label. */
  clock: () => (
    <svg {...svg}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3.2 2" />
    </svg>
  ),
  /* A map pin: which campus the camera is on. */
  pin: () => (
    <svg {...svg}>
      <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" />
      <circle cx="12" cy="10" r="2.4" />
    </svg>
  ),
  /* Four tiles: the dashboard's bento of cards. */
  dashboard: () => (
    <svg {...svg}>
      <rect x="3.5" y="3.5" width="7" height="9" rx="2" />
      <rect x="13.5" y="3.5" width="7" height="5" rx="2" />
      <rect x="13.5" y="11.5" width="7" height="9" rx="2" />
      <rect x="3.5" y="15.5" width="7" height="5" rx="2" />
    </svg>
  ),
  chevronDown: () => (
    <svg {...svg} width={14} height={14}>
      <path d="m6 9.5 6 5.5 6-5.5" />
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
      {playing ? <path d="M9 5v14M15 5v14" /> : <path d="M7.5 4.8v14.4L19 12z" fill="currentColor" stroke="none" />}
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
  /* Fast-forward, mirrored. Drawn rather than rotated so its points land on the
     same pixels as its twin and the pair reads as symmetrical. */
  rewind: () => (
    <svg {...svg}>
      <path d="M20 5.5v13L12 12z" fill="currentColor" stroke="none" />
      <path d="M11.5 5.5v13L3.5 12z" fill="currentColor" stroke="none" />
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
 * Popovers
 * ------------------------------------------------------------------------- */
/*
 * Close on a click outside, or on Escape.
 *
 * Shared by the three things here that hang off a button: the campus menu, the
 * building-tag flyout and the month. pointerdown rather than click, so a press
 * that starts on the map dismisses before it pans.
 */
function useDismiss(open: boolean, root: { current: HTMLElement | null }, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
    // close is re-created each render by callers; the listeners only read it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

/* ---------------------------------------------------------------------------
 * Brand
 * ------------------------------------------------------------------------- */
/*
 * The wordmark, with the way back to the dashboard right beside it. The campus
 * picker used to sit here too, but few people switch campus and rarely, so it
 * lives at the foot of the rail with the other occasional map settings.
 */
/** The landing page, served by the web app on the same origin as /map (web/src/App.tsx). */
const LANDING_URL = '/landing';

export function HudBrand({
  name,
  dashboardHref,
}: {
  name: string;
  /** Where "Dashboard" goes: the student dashboard, served by the same app. */
  dashboardHref?: string;
}) {
  return (
    <div className="hud-brand">
      {/* The mark and name go to the landing page, as the dashboard's logo does (web/src/layouts/AppShell.tsx). */}
      <a className="hud-brand-home" href={LANDING_URL} aria-label={`${name} home page`}>
        {/* Drawn inline, so it takes the app's theme (--brand-mark) rather than the system's, as the favicon would. */}
        <svg className="hud-brand-mark" viewBox={MARK_VIEWBOX} aria-hidden focusable="false">
          <path d={MARK_PATH} />
        </svg>
        <span className="hud-brand-name">{name}</span>
      </a>

      {dashboardHref && (
        <a className="hud-dashboard" href={dashboardHref} aria-label="Dashboard" title="Your dashboard">
          <HudIcons.dashboard />
          <span>Dashboard</span>
        </a>
      )}
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
  /**
   * The layer's hue, as a `--hue-*` name from styles.css. An "on" toggle wears
   * it, so six active layers stay tellable apart; off is always grey.
   */
  hue?: 'teal' | 'green' | 'violet' | 'orange' | 'pink' | 'neutral';
  onSelect: () => void;
}

/** A rail button that opens a small radio menu beside the rail: the campus picker. */
function RailMenu<T extends string>({
  label,
  heading = label,
  icon,
  options,
  value,
  onPick,
}: {
  label: string;
  /** The menu's title, when the button's label carries more (the current campus). */
  heading?: string;
  icon: ReactNode;
  options: readonly { id: T; label: string; detail?: string }[];
  value: T;
  onPick: (id: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useDismiss(open, root, () => setOpen(false));
  return (
    <div className="hud-rail-tags" ref={root}>
      <button
        type="button"
        className="hud-rail-button"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={label}
        title={label}
        onClick={() => setOpen((v) => !v)}
      >
        {icon}
      </button>

      {open && (
        <div className="hud-tag-menu" role="menu" aria-label={heading}>
          <p className="hud-tag-menu-head">{heading}</p>
          {options.map((m) => (
            <button
              key={m.id}
              type="button"
              role="menuitemradio"
              aria-checked={value === m.id}
              onClick={() => {
                onPick(m.id);
                setOpen(false);
              }}
            >
              <span className="hud-tag-menu-label">{m.label}</span>
              {m.detail && <span className="hud-tag-menu-detail">{m.detail}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/*
 * The layer toggles down the left edge, then a divider and the campus picker. The divider is not
 * decoration: everything above it adds something to the map, while the button below it moves it.
 */
export function HudRail({
  items,
  campus,
}: {
  items: RailItem[];
  /** The campus picker, at the foot of the rail. Left out when there is only one campus. */
  campus?: { current: string; options: readonly { id: string; name: string }[]; onPick: (id: string) => void };
}) {
  const pickCampus = campus && campus.options.length > 1;
  return (
    <nav className="hud-rail" aria-label="Map layers">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="hud-rail-button"
          data-hue={item.hue}
          aria-label={item.label}
          aria-pressed={item.on}
          disabled={item.disabled}
          title={item.label}
          onClick={item.onSelect}
        >
          {item.icon}
        </button>
      ))}

      {pickCampus && <span className="hud-rail-divider" aria-hidden="true" />}

      {pickCampus && (
        <RailMenu
          label={`Campus: ${campus.options.find((c) => c.id === campus.current)?.name ?? 'pick one'}`}
          heading="Campus"
          icon={<HudIcons.pin />}
          options={campus.options.map((c) => ({ id: c.id, label: c.name }))}
          value={campus.current}
          onPick={campus.onPick}
        />
      )}
    </nav>
  );
}

/* ---------------------------------------------------------------------------
 * Top tabs: what you are reading.
 * ------------------------------------------------------------------------- */
export interface HudTab<T extends string> {
  id: T;
  label: string;
  icon?: ReactNode;
  /** The tab's hue, worn by its icon only; the selected fill stays neutral. */
  hue?: 'teal' | 'green' | 'violet' | 'orange' | 'pink';
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
          data-hue={t.hue}
          onClick={() => onSelect(t.id)}
        >
          {t.icon}
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Top right: the clock, the weather and the time controls.
 * ------------------------------------------------------------------------- */
/*
 * One card in the top right for everything about when.
 *
 * The reading sits on top -- the clock and the temperature, the two things you
 * glance at -- and everything that changes the time sits under it: the day and
 * the drag bar, then the transport and the speeds. They were a floating plate
 * and a separate bar before, two materials for one subject.
 *
 * On a phone the controls fold away under the reading (hud.css), and the
 * chevron at the end of it opens them; on a wide screen it is hidden and the
 * card is always open.
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
  const [open, setOpen] = useState(false);
  const hasControls = Boolean(day || scrubber || controls);

  return (
    <div className="hud-status" role="group" aria-label="Time and weather" data-open={open || undefined}>
      <div className="hud-status-reading">
        <HudIcons.clock />
        <output className="hud-clock" aria-live="off">
          {time}
        </output>
        {live && <span className="hud-live">Clock</span>}
        <span className="hud-status-spacer" />
        {children}
        {hasControls && (
          <button
            type="button"
            className="hud-status-more"
            aria-expanded={open}
            aria-controls="hud-status-controls"
            aria-label={open ? 'Hide time controls' : 'Show time controls'}
            onClick={() => setOpen((o) => !o)}
          >
            <HudIcons.chevronDown />
          </button>
        )}
      </div>

      {hasControls && (
        <div className="hud-status-controls" id="hud-status-controls">
          {(day || scrubber) && (
            <div className="hud-status-row">
              {day}
              {scrubber && <div className="hud-scrubber">{scrubber}</div>}
            </div>
          )}
          {controls}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Legend, bottom left.
 * ------------------------------------------------------------------------- */
/*
 * What the colours mean, built from the scale itself.
 *
 * The ranges are derived from each level's `min` rather than written out, so a
 * threshold can never be changed in theme/crowd.ts and left stale here. Each
 * item carries its icon, its word and its range: the icon is what appears on the
 * map, and the word is what makes the colour legible to anyone who cannot
 * separate the three hues.
 */
export function HudLegend({
  levels,
}: {
  levels: readonly { key: string; label: string; range: string; icon: ReactNode }[];
}) {
  return (
    <div className="hud-legend" role="group" aria-label="Crowd scale">
      {levels.map((l) => (
        <span key={l.key} className="hud-legend-item" data-level={l.key}>
          {l.icon}
          <b>{l.label}</b>
          <span>{l.range}</span>
        </span>
      ))}
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
  /** Signed: negative runs the day backwards. */
  speed: number;
  speeds: readonly number[];
  onSpeed: (s: number) => void;
  live: boolean;
  onLive: () => void;
}) {
  const magnitude = Math.abs(speed) || 1;
  const backwards = speed < 0;
  const sign = backwards ? -1 : 1;

  return (
    <div className="hud-time" role="group" aria-label="Time">
      {/*
        Rewind, play and fast-forward, with the speeds themselves beside them.
        The buttons choose the direction and the pills choose how fast, which is
        two questions rather than one ladder to step through: you nearly always
        know which speed you want, and stepping to it past the others means
        watching the day lurch on the way.
      */}
      <button
        type="button"
        className="hud-step"
        aria-pressed={backwards}
        aria-label="Run the day backwards"
        title="Backwards"
        onClick={() => onSpeed(-magnitude)}
      >
        <HudIcons.rewind />
      </button>

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
        aria-pressed={!backwards}
        aria-label="Run the day forwards"
        title="Forwards"
        onClick={() => onSpeed(magnitude)}
      >
        <HudIcons.fastForward />
      </button>

      <div className="hud-speeds" role="group" aria-label="Speed">
        {speeds.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={!live && magnitude === s}
            aria-label={`${s} times real time${backwards ? ', backwards' : ''}`}
            onClick={() => onSpeed(s * sign)}
          >
            {s}&#215;
          </button>
        ))}
      </div>

      <button type="button" className="hud-live-toggle" aria-pressed={live} onClick={onLive} title="Follow Boston time and live transit">
        {live ? 'Live' : 'Go live'}
      </button>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * The date, and the month behind it.
 *
 * Shows the real date being simulated rather than a weekday name: "Sat 24 Oct"
 * answers both questions at once, and a weekday alone does not say which week.
 * Clicking opens the month, because picking a date from a list of seven day
 * names is not how anyone thinks about when.
 *
 * All dates here are ISO yyyy-mm-dd and built in local time. Constructing them
 * from Date.toISOString would shift the day backwards for anyone west of UTC,
 * which is everyone this map is for.
 * ------------------------------------------------------------------------- */

const DAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Parsed as local midday, so a timezone offset can never move it to another day. */
const fromIso = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, 12);
};

export function HudDate({ value, onPick }: { value: string; onPick: (date: string) => void }) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => fromIso(value));
  const root = useRef<HTMLDivElement>(null);

  // Re-centre on the selected date each time it opens, not on every change:
  // paging through months while open should stay where the user left it.
  useEffect(() => {
    if (open) setMonth(fromIso(value));
  }, [open, value]);

  useDismiss(open, root, () => setOpen(false));

  const selected = fromIso(value);
  const today = iso(new Date());
  const label = selected.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' });

  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const lead = first.getDay();
  const cells: (Date | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => new Date(month.getFullYear(), month.getMonth(), i + 1, 12)),
  ];

  const shift = (by: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + by, 1, 12));

  return (
    <div className="hud-date" ref={root}>
      <button
        type="button"
        className="hud-date-button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        title="Pick a date to simulate"
      >
        {label}
      </button>

      {open && (
        <div className="hud-month" role="dialog" aria-label="Pick a date">
          <div className="hud-month-head">
            <button type="button" onClick={() => shift(-1)} aria-label="Previous month">
              ‹
            </button>
            <span>{month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</span>
            <button type="button" onClick={() => shift(1)} aria-label="Next month">
              ›
            </button>
          </div>

          <div className="hud-month-grid" role="grid">
            {DAY_INITIALS.map((d, i) => (
              <span key={i} className="hud-month-day" aria-hidden="true">
                {d}
              </span>
            ))}
            {cells.map((d, i) =>
              d === null ? (
                <span key={`pad-${i}`} />
              ) : (
                <button
                  key={iso(d)}
                  type="button"
                  className="hud-month-cell"
                  aria-pressed={iso(d) === value}
                  data-today={iso(d) === today || undefined}
                  onClick={() => {
                    onPick(iso(d));
                    setOpen(false);
                  }}
                >
                  {d.getDate()}
                </button>
              ),
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Bottom centre: ask.
 * ------------------------------------------------------------------------- */
export function HudAsk({ children }: { children: ReactNode }) {
  return <div className="hud-ask">{children}</div>;
}
