import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { ArrowRight, Menu, X } from 'lucide-react';
import { Link } from 'react-router';
import { crowdFor, crowdScale } from '@theme/tokens';
import { config } from '../config';
import { Logo } from '../ui/Logo';
import { api, useResource } from '../data/api';
import { formatPercent } from '../lib/format';
import { CampusScene } from './landing/CampusScene';
import { HeroScene, type HeroSceneHandle } from './landing/HeroScene';
import { TitleScreen } from './landing/TitleScreen';
import type { DepthState } from './landing/useDepth';
import {
  HOURS,
  FIRST_HOUR,
  LAST_HOUR,
  addDays,
  clockLabel,
  dayForecast,
  eventExample,
  hourLabel,
  longDate,
  peaks,
  shortDate,
  weekdayName,
  type DayForecast,
  type EventExample,
} from './landing/forecast';
import styles from './Landing.module.css';

/** The public front page: signed-out visitors see it at /, and anyone at /landing. */

const SECTIONS = [
  { id: 'how', label: 'How it works' },
  { id: 'features', label: 'Features' },
  { id: 'transparency', label: 'Transparency' },
  { id: 'privacy', label: 'Privacy' },
] as const;

const GITHUB_URL = 'https://github.com/Darkest-Teddy/Flowcast';

/** The hour the hero and the preview open on. */
const HERO_HOUR = 18;

/** The places the hero tags point at, with how long each tag's stem is. */
const HERO_TAGS = [
  { place: 'mugar', stem: 44 },
  { place: 'warren', stem: 72 },
  { place: 'questrom', stem: 30 },
  { place: 'fitrec', stem: 58 },
];

const PREVIEW_PLACES = ['mugar', 'warren-dining', 'fitrec'];
const KIND_LABEL: Record<string, string> = { library: 'Library', dining: 'Dining hall', gym: 'Gym', classroom: 'Academic building', dorm: 'Residence' };

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Scrolls to a section (smoothly unless reduced motion is on), moves focus there and updates the address. */
function goToSection(event: MouseEvent<HTMLAnchorElement>, id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  event.preventDefault();
  target.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  target.focus({ preventScroll: true });
  window.history.replaceState(window.history.state, '', `#${id}`);
}

/** "Busy 71%". */
const reading = (share: number) => `${crowdFor(share).label} ${formatPercent(share)}`;

function Dot({ share, size = 'md' }: { share: number; size?: 'sm' | 'md' | 'lg' }) {
  return <span className={`${styles.dot} ${styles[`dot-${size}`]}`} style={{ background: crowdFor(share).color }} aria-hidden />;
}

/*
 * The title screen: the live 3D campus with the wordmark over it.
 *
 * Two ways out, both landing in the same place. Clicking the action flies the camera
 * into campus; simply scrolling lifts the overlay and continues into the rest of the
 * page. Scroll is never trapped, so a visitor who ignores it entirely just gets an
 * ordinary page.
 *
 * This holds the page's only live renderer. The feature thumbnails further down keep
 * the CSS scene: seven WebGL contexts would exceed what browsers allow.
 */
function TitleSection() {
  const sceneRef = useRef<HeroSceneHandle | null>(null);
  const [ready, setReady] = useState(false);

  const onDepthFrame = useCallback((state: DepthState) => {
    sceneRef.current?.applyDepth(state);
  }, []);

  const onCommit = useCallback(() => {
    sceneRef.current?.commit();
  }, []);

  const onSceneReady = useCallback((h: HeroSceneHandle) => {
    sceneRef.current = h;
    setReady(true);
  }, []);

  return (
    <section
      className={`${styles.dark} ${styles.titleSection}`}
      data-theme="dark"
      aria-label="Flowcast, a live 3D model of the Boston University campus"
    >
      <HeroScene onReady={onSceneReady} />
      <TitleScreen
        title="Flowcast"
        lede="Boston University, live. Students on real class schedules, the Green Line down Comm Ave."
        onCommit={onCommit}
        onDepthFrame={onDepthFrame}
        cue="Scroll to see how it works"
        ready={ready}
      >
        {/* A button, not a link: this flies the camera down into campus. The link
            out to the full map is in the nav and at the end of the page. */}
        <button type="button" className={`${styles.cta} ${styles.ctaLarge}`}>
          Explore the campus
        </button>
      </TitleScreen>
    </section>
  );
}

export default function Landing() {
  const impact = useResource(api.getEventImpact);
  const day = useMemo(() => (impact.data ? dayForecast(impact.data) : null), [impact.data]);
  const event = useMemo(() => (impact.data ? eventExample(impact.data) : null), [impact.data]);

  useEffect(() => {
    const previous = document.title;
    document.title = 'Flowcast · Crowd forecasts for Boston University';
    return () => {
      document.title = previous;
    };
  }, []);

  // A link straight to a section (/landing#privacy): the sections render with the page, so jump there once.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id) document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }, []);

  return (
    <div className={styles.page}>
      <a className={styles.skip} href="#main">
        Skip to content
      </a>
      <LandingNav />
      <main id="main" tabIndex={-1} className={styles.main}>
        <TitleSection />
        <Hero day={day} />
        <Preview day={day} error={impact.error} reload={impact.reload} />
        <HowItWorks />
        <Features day={day} event={event} />
        <Transparency day={day} />
        <PrivacySection />
        <Closing day={day} />
      </main>
      <footer className={`${styles.dark} ${styles.footer}`} data-theme="dark">
        <div className={styles.footerRow}>
          <span>Flowcast · Built at Hackachusetts, Civic Action track, by a team of 4.</span>
          <a href={GITHUB_URL}>GitHub</a>
        </div>
      </footer>
    </div>
  );
}

function LandingNav() {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Escape closes the phone menu and gives focus back to its button.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const links = SECTIONS.map((s) => (
    <li key={s.id}>
      <a
        href={`#${s.id}`}
        className={styles.navLink}
        onClick={(e) => {
          setOpen(false);
          goToSection(e, s.id);
        }}
      >
        {s.label}
      </a>
    </li>
  ));

  return (
    <header className={styles.navBar} data-theme="dark">
      <nav aria-label="Main" className={styles.nav}>
        <a href="#top" className={styles.brand} onClick={(e) => goToSection(e, 'top')}>
          <Logo className={styles.mark} />
          Flowcast
        </a>
        <ul className={styles.navLinks}>{links}</ul>
        <div className={styles.navEnd}>
          <a href={config.mapUrl} className={`${styles.cta} ${styles.navCta}`}>
            Open the map
          </a>
          <button
            ref={buttonRef}
            type="button"
            className={styles.menuButton}
            aria-expanded={open}
            aria-controls={menuId}
            aria-label="Sections"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? <X aria-hidden /> : <Menu aria-hidden />}
          </button>
        </div>
        <ul id={menuId} className={styles.menu} hidden={!open}>
          {links}
        </ul>
      </nav>
    </header>
  );
}

/* ---------- 01 Hero ---------- */

interface TagSpot {
  x: number;
  y: number;
}

function Hero({ day }: { day: DayForecast | null }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [spots, setSpots] = useState<Record<string, TagSpot | null>>({});

  // Tags point at roofs in the 3D scene, so their positions come from measuring it. A tag that would
  // leave the stage or run into the forecast card is hidden.
  const measure = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const box = stage.getBoundingClientRect();
    const card = cardRef.current?.getBoundingClientRect();
    const next: Record<string, TagSpot | null> = {};
    for (const tag of HERO_TAGS) {
      const anchor = stage.querySelector(`[data-anchor="${tag.place}"]`);
      if (!anchor) continue;
      const r = anchor.getBoundingClientRect();
      const x = r.left + r.width / 2 - box.left;
      const y = r.top + r.height / 2 - box.top;
      const top = y - tag.stem - 34;
      let show = x > 90 && x < box.width - 90 && top > 8;
      if (card && show) {
        const cl = card.left - box.left;
        const cr = card.right - box.left;
        const ct = card.top - box.top;
        if (x > cl - 110 && x < cr + 110 && y > ct - 20) show = false;
      }
      next[tag.place] = show ? { x, y } : null;
    }
    setSpots(next);
  }, []);

  useLayoutEffect(() => {
    measure();
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [measure, day]);

  const shareOf = useCallback((place: string) => day?.share(place, HERO_HOUR) ?? null, [day]);
  const mugar = day?.share('mugar', HERO_HOUR) ?? null;
  const next = [1, 2, 3, 4].map((k) => Math.min(LAST_HOUR, HERO_HOUR + k));

  return (
    <section id="top" tabIndex={-1} className={`${styles.dark} ${styles.hero}`} data-theme="dark" aria-labelledby="hero-title">
      <div className={styles.heroText}>
        <p className={styles.heroEyebrow}>Crowd forecasts for Boston University</p>
        <h1 id="hero-title" className={styles.heroTitle}>
          See how busy campus is before you go.
        </h1>
        <p className={styles.heroLede}>
          Flowcast forecasts how full BU’s libraries, dining halls and gyms will be, hour by hour, from the published Fall 2026 class
          schedule.
        </p>
        <div className={styles.heroActions}>
          <a href={config.mapUrl} className={`${styles.cta} ${styles.ctaLarge}`}>
            Open the map
          </a>
          <Link to="/signin" className={`${styles.glassCta} ${styles.ctaLarge}`}>
            Continue with Google
          </Link>
        </div>
      </div>

      <div ref={stageRef} className={styles.stage}>
        <div className={styles.heroScene}>
          <CampusScene shareOf={shareOf} dy={-30} />
        </div>

        {day &&
          HERO_TAGS.map((tag) => {
            const spot = spots[tag.place];
            const share = day.share(tag.place, HERO_HOUR);
            const place = day.place(tag.place);
            if (share == null || !place) return null;
            return (
              <div
                key={tag.place}
                className={`${styles.tag} ${spot ? styles.tagShown : ''}`}
                style={{ left: spot?.x ?? 0, top: spot?.y ?? 0 }}
                aria-hidden
              >
                <div className={styles.tagPill}>
                  <Dot share={share} size="sm" />
                  <span>{place.short}</span>
                  <span className={styles.tagSep}>·</span>
                  <b>{reading(share)}</b>
                </div>
                <div className={styles.stem} style={{ height: tag.stem }} />
              </div>
            );
          })}

        <div ref={cardRef} className={styles.heroCard}>
          {day && mugar != null ? (
            <>
              <p className={styles.heroCardWhen}>
                Projected · {weekdayName(day.date)} {hourLabel(HERO_HOUR)}
              </p>
              <p className={styles.heroCardPlace}>{day.place('mugar')?.name}</p>
              <p className={styles.heroCardNow}>
                <Dot share={mugar} size="lg" />
                <span>{reading(mugar)}</span>
              </p>
              <ol className={styles.heroNext} aria-label="Next four hours">
                {next.map((hour) => {
                  const share = day.share('mugar', hour) ?? 0;
                  return (
                    <li key={hour}>
                      <span className={styles.heroNextBar} aria-hidden>
                        <span style={{ height: `${Math.max(3, Math.min(100, share * 100))}%`, background: crowdFor(share).color }} />
                      </span>
                      <span className={styles.heroNextHour}>{hourLabel(hour)}</span>
                      <span className={styles.heroNextValue}>
                        {formatPercent(share)}
                        <span className="visually-hidden"> {crowdFor(share).label}</span>
                      </span>
                    </li>
                  );
                })}
              </ol>
            </>
          ) : (
            <p className={styles.heroCardWhen}>Loading the forecast…</p>
          )}
        </div>
      </div>
    </section>
  );
}

/* ---------- 02 Live preview ---------- */

function Preview({ day, error, reload }: { day: DayForecast | null; error: Error | null; reload: () => void }) {
  const [placeIndex, setPlaceIndex] = useState(0);
  const [hour, setHour] = useState(HERO_HOUR);

  return (
    <section className={`${styles.section} ${styles.previewSection}`} aria-labelledby="preview-title">
      <div className={styles.container}>
        <h2 id="preview-title" className={styles.sectionTitle}>
          Plan around the rush.
        </h2>
        <p className={styles.previewLede}>
          Pick a place, then an hour, to see its forecast{day ? ` for ${longDate(day.date)}` : ''}.
        </p>
        <div className={styles.previewCard}>
          {day ? (
            <PreviewBody day={day} placeIndex={placeIndex} setPlaceIndex={setPlaceIndex} hour={hour} setHour={setHour} />
          ) : error ? (
            <div className={styles.previewStatus} role="alert">
              <p>The forecast couldn’t load. {error.message}</p>
              <button type="button" className={styles.pillButton} onClick={reload}>
                Try again
              </button>
            </div>
          ) : (
            <p className={styles.previewStatus} role="status">
              Loading the forecast…
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function PreviewBody({
  day,
  placeIndex,
  setPlaceIndex,
  hour,
  setHour,
}: {
  day: DayForecast;
  placeIndex: number;
  setPlaceIndex: (i: number) => void;
  hour: number;
  setHour: (h: number) => void;
}) {
  const places = PREVIEW_PLACES.map((id) => day.place(id)).filter((p) => p != null);
  const place = places[Math.min(placeIndex, places.length - 1)];
  const barsRef = useRef<HTMLDivElement>(null);
  const share = day.share(place.id, hour) ?? 0;
  const level = crowdFor(share);
  const { busiest, quietest } = peaks(day, place.id);
  const at = (h: number) => day.share(place.id, h) ?? 0;

  function hourFromPointer(e: PointerEvent<HTMLDivElement>) {
    const box = barsRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return;
    const i = Math.floor(((e.clientX - box.left) / box.width) * HOURS.length);
    setHour(HOURS[Math.max(0, Math.min(HOURS.length - 1, i))]);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const step: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 3, PageDown: -3 };
    let next: number | null = null;
    if (e.key in step) next = Math.max(FIRST_HOUR, Math.min(LAST_HOUR, hour + step[e.key]));
    else if (e.key === 'Home') next = FIRST_HOUR;
    else if (e.key === 'End') next = LAST_HOUR;
    if (next !== null) {
      e.preventDefault();
      setHour(next);
    }
  }

  return (
    <>
      <div className={styles.previewBar}>
        <div role="group" aria-label="Choose a place" className={styles.placeTabs}>
          {places.map((p, i) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={p.id === place.id}
              className={styles.placeTab}
              onClick={() => setPlaceIndex(i)}
            >
              {p.short}
            </button>
          ))}
        </div>
        <span className={styles.previewNote}>
          Projected occupancy · {hourLabel(FIRST_HOUR)} to {hourLabel(LAST_HOUR)}
        </span>
      </div>
      <div className={styles.previewBody}>
        <div className={styles.previewDetail} aria-live="polite">
          <p className={styles.previewKind}>{KIND_LABEL[place.kind] ?? place.kind}</p>
          <p className={styles.previewName}>{place.name}</p>
          <p className={styles.previewHour}>{hourLabel(hour)}</p>
          <p className={styles.previewValue}>
            <Dot share={share} size="lg" />
            <span>{formatPercent(share)}</span>
          </p>
          <p className={styles.previewLevel}>{level.label}</p>
          <p className={styles.previewSummary}>
            Busiest at {hourLabel(busiest)} ({formatPercent(at(busiest))}). Quietest at {hourLabel(quietest)} ({formatPercent(at(quietest))}).
          </p>
        </div>
        <div className={styles.chart}>
          <div className={styles.plot}>
            {[0.4, 0.65, 0.85].map((t) => (
              <div key={t} className={styles.threshold} style={{ bottom: `${t * 100}%` }} aria-hidden>
                <span>{formatPercent(t)}</span>
              </div>
            ))}
            <div
              ref={barsRef}
              className={styles.bars}
              role="slider"
              tabIndex={0}
              aria-label="Hour of day"
              aria-valuemin={FIRST_HOUR}
              aria-valuemax={LAST_HOUR}
              aria-valuenow={hour}
              aria-valuetext={`${hourLabel(hour)}: ${level.label}, ${formatPercent(share)}`}
              onKeyDown={onKeyDown}
              onPointerDown={hourFromPointer}
              onPointerMove={(e) => {
                if (e.pointerType === 'mouse' || e.buttons) hourFromPointer(e);
              }}
            >
              {HOURS.map((h) => {
                const s = at(h);
                return (
                  <span key={h} className={`${styles.barSlot} ${h === hour ? styles.barSelected : ''}`}>
                    <span className={styles.bar} style={{ height: `${Math.max(2, Math.min(100, s * 100))}%`, background: crowdFor(s).color }} />
                  </span>
                );
              })}
            </div>
          </div>
          <div className={styles.axis} aria-hidden>
            {HOURS.map((h, i) => (
              <span key={h} className={h === hour ? styles.axisSelected : undefined}>
                {h === hour || (i % 3 === 0 && Math.abs(h - hour) > 1) ? hourLabel(h) : ''}
              </span>
            ))}
          </div>
          <ul className={styles.legend} aria-label="Crowd levels">
            {crowdScale.map((s, i) => (
              <li key={s.level}>
                <span className={styles.legendSwatch} style={{ background: s.color }} aria-hidden />
                {s.label} {legendRange(i)}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}

/** "under 40%", "40–65%", "85%+". */
function legendRange(i: number, long = false) {
  const from = i > 0 ? Math.round(crowdScale[i - 1].upTo * 100) : 0;
  const to = crowdScale[i].upTo;
  if (i === 0) return `under ${Math.round(to * 100)}%`;
  if (!Number.isFinite(to)) return long ? `${from}% and up` : `${from}%+`;
  return `${from}–${Math.round(to * 100)}%`;
}

/* ---------- 03 How it works ---------- */

function HowItWorks() {
  return (
    <section id="how" tabIndex={-1} className={`${styles.section} ${styles.howSection}`} aria-labelledby="how-title">
      <div className={styles.container}>
        <p className={styles.eyebrow}>How it works</p>
        <h2 id="how-title" className={`${styles.sectionTitle} ${styles.narrowTitle}`}>
          From public schedules to hourly forecasts.
        </h2>
        <ol className={styles.steps}>
          <li className={styles.step}>
            <div className={styles.stepHead}>
              <span className={styles.stepNumber} aria-hidden>
                1
              </span>
              <h3 className={styles.stepTitle}>Public BU data</h3>
            </div>
            <dl className={styles.facts}>
              <div>
                <dt>Class meetings</dt>
                <dd>5,904</dd>
              </div>
              <div>
                <dt>Classroom capacities</dt>
                <dd>437</dd>
              </div>
              <div>
                <dt>Campus events</dt>
                <dd>88</dd>
              </div>
              <div>
                <dt>Dining, library and gym hours</dt>
                <dd className={styles.factWord}>Posted</dd>
              </div>
            </dl>
          </li>
          <li className={styles.step}>
            <div className={styles.stepHead}>
              <span className={styles.stepNumber} aria-hidden>
                2
              </span>
              <h3 className={styles.stepTitle}>Schedule-driven simulation</h3>
            </div>
            <div className={styles.bigFact}>
              <p className={styles.bigNumber}>36,977</p>
              <p className={styles.muted}>simulated students</p>
            </div>
            <p className={styles.muted}>
              Each one follows a Fall 2026 class schedule and walks between buildings, and many eat, study and work out within posted
              hours.
            </p>
          </li>
          <li className={styles.step}>
            <div className={styles.stepHead}>
              <span className={styles.stepNumber} aria-hidden>
                3
              </span>
              <h3 className={styles.stepTitle}>Hourly forecasts on a map</h3>
            </div>
            <p className={`${styles.muted} ${styles.ruled}`}>
              Each of 101 places gets a projected occupancy for every hour, as a share of its capacity, shown on one scale.
            </p>
            <ul className={styles.levels}>
              {crowdScale.map((s, i) => (
                <li key={s.level}>
                  <span className={styles.levelName}>
                    <span className={`${styles.dot} ${styles['dot-sm']}`} style={{ background: s.color }} aria-hidden />
                    {s.label}
                  </span>
                  <span className={styles.muted}>{legendRange(i, true)}</span>
                </li>
              ))}
            </ul>
          </li>
        </ol>
      </div>
    </section>
  );
}

/* ---------- 04 Features ---------- */

function Features({ day, event }: { day: DayForecast | null; event: EventExample | null }) {
  const shareAt = (hour: number) => (place: string) => day?.share(place, hour) ?? null;
  const row = (place: string, hour: number) => {
    const share = day?.share(place, hour);
    const p = day?.place(place);
    if (share == null || !p) return null;
    return (
      <div className={styles.mockRow} key={`${place}-${hour}`}>
        <span>
          {p.short} · {hourLabel(hour)}
        </span>
        <span className={styles.mockReading}>
          <Dot share={share} size="sm" />
          {reading(share)}
        </span>
      </div>
    );
  };

  return (
    <section id="features" tabIndex={-1} className={`${styles.section} ${styles.sectionAlt}`} aria-labelledby="features-title">
      <div className={styles.container}>
        <p className={styles.eyebrow}>Features</p>
        <h2 id="features-title" className={`${styles.sectionTitle} ${styles.narrowTitle}`}>
          See the campus, then plan the trip.
        </h2>

        <div className={styles.featureGrid}>
          <article className={`${styles.feature} ${styles.featureWide}`}>
            <div className={styles.featureText}>
              <h3 className={styles.featureTitleLarge}>3D campus map</h3>
              <p className={styles.featureBody}>
                Charles River, Fenway and Medical in one model. Each building is colored by how full it’s projected to be. Rotate, zoom,
                select any building for its classes and hours, and scrub the timeline to any hour.
              </p>
            </div>
            <div className={`${styles.dark} ${styles.featureVisual} ${styles.featureVisualWide}`} data-theme="dark">
              <CampusScene shareOf={shareAt(HERO_HOUR)} scale={0.62} dx={-40} dy={10} />
              <div className={styles.campusPicker} aria-hidden>
                <span className={styles.campusPickerOn}>Charles River</span>
                <span>Fenway</span>
                <span>Medical</span>
              </div>
            </div>
          </article>

          <article className={styles.feature}>
            <div className={`${styles.dark} ${styles.featureVisual}`} data-theme="dark">
              <CampusScene shareOf={shareAt(HERO_HOUR)} scale={0.5} dx={-90} dy={10} />
              <div className={`${styles.mockCard} ${styles.mockList}`}>
                {row('pardee', 18)}
                {row('mugar', 21)}
                {row('fitrec', 7)}
              </div>
            </div>
            <div className={styles.featureText}>
              <h3 className={styles.featureTitle}>Crowd forecasts</h3>
              <p className={styles.featureBody}>
                Pick a date and a place and see whether it will be quiet or packed, every hour from 7 AM to 11 PM.
              </p>
            </div>
          </article>

          <article className={styles.feature}>
            <div className={`${styles.dark} ${styles.featureVisual}`} data-theme="dark">
              <CampusScene shareOf={shareAt(event?.hour ?? 19)} scale={0.5} dx={160} dy={20} />
              {event && (
                <div className={`${styles.mockCard} ${styles.mockPad}`}>
                  <div className={styles.dateChips}>
                    <span>{shortDate(addDays(event.date, -1))}</span>
                    <span className={styles.dateChipOn}>{shortDate(event.date)}</span>
                    <span>{shortDate(addDays(event.date, 1))}</span>
                  </div>
                  <div>
                    <p className={styles.mockStrong}>
                      {event.name} at {event.venue.short}, {clockLabel(event.startSec)}
                    </p>
                    <p className={styles.mockMuted}>
                      {event.venue.short} {formatPercent(event.before)} → {formatPercent(event.after)} at {hourLabel(event.hour)}
                    </p>
                  </div>
                </div>
              )}
            </div>
            <div className={styles.featureText}>
              <h3 className={styles.featureTitle}>Event impact by date</h3>
              <p className={styles.featureBody}>
                Choose a date to see how scheduled campus events shift crowds in the buildings that host them.
              </p>
            </div>
          </article>

          <article className={styles.feature}>
            <div className={`${styles.dark} ${styles.featureVisual}`} data-theme="dark">
              <CampusScene shareOf={shareAt(HERO_HOUR)} scale={0.5} dx={40} dy={-30} />
              <div className={`${styles.mockCard} ${styles.mockList}`}>
                <div className={styles.mockRow}>
                  <span>Green Line B · BU Central</span>
                  <b>3 min</b>
                </div>
                <div className={styles.mockRow}>
                  <span>BU Shuttle · Marsh Plaza</span>
                  <b>8 min</b>
                </div>
                <div className={styles.mockRow}>
                  <span>Bluebikes · BU Central T</span>
                  <b>5 bikes</b>
                </div>
              </div>
            </div>
            <div className={styles.featureText}>
              <h3 className={styles.featureTitle}>Live MBTA, BU Shuttle and Bluebikes</h3>
              <p className={styles.featureBody}>
                Real-time arrivals and bike counts on the map, next to the forecast, so you can time the trip as well as the visit.
              </p>
            </div>
          </article>

          <article className={styles.feature}>
            <div className={`${styles.dark} ${styles.featureVisual}`} data-theme="dark">
              <CampusScene shareOf={shareAt(20)} scale={0.5} dx={-20} dy={30} />
              <div className={`${styles.mockCard} ${styles.mockPad}`}>
                {/* A Tuesday run of map-client's simulation with this closure: Law Library 184 → 269 of 300 people at 8 PM. */}
                <p className={styles.mockStrong}>Building closure · Mugar Library · 8 PM</p>
                <p className={styles.mockChange}>
                  <span className={styles.mockMuted}>Law Library</span>
                  <span className={styles.mockReadingPlain}>
                    <Dot share={0.61} size="sm" />
                    {reading(0.61)}
                  </span>
                  <ArrowRight className={styles.mockArrow} aria-label="becomes" />
                  <span className={styles.mockReading}>
                    <Dot share={0.9} size="sm" />
                    {reading(0.9)}
                  </span>
                </p>
              </div>
            </div>
            <div className={styles.featureText}>
              <h3 className={styles.featureTitle}>What-if incidents</h3>
              <p className={styles.featureBody}>
                Add a fire drill, a building closure or an earthquake and see where the displaced crowd goes.
              </p>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}

/* ---------- 05 Transparency ---------- */

function Transparency({ day }: { day: DayForecast | null }) {
  const share = day?.share('mugar', HERO_HOUR) ?? null;
  const busiest = day ? peaks(day, 'mugar').busiest : null;
  return (
    <section id="transparency" tabIndex={-1} className={styles.section} aria-labelledby="transparency-title">
      <div className={`${styles.container} ${styles.transparencyGrid}`}>
        <div>
          <p className={styles.eyebrow}>Transparency</p>
          <h2 id="transparency-title" className={styles.sectionTitle}>
            Every number is a projection.
          </h2>
          <p className={styles.transparencyBody}>
            Flowcast’s crowd levels come from a simulation built on stated assumptions, such as students attending their scheduled classes
            and eating during posted dining hours. They are not measurements of real students. The map’s Data tab shows the published BU
            source behind each building’s classes and hours.
          </p>
        </div>
        <div className={styles.evidence}>
          <p className={styles.evidenceTitle}>
            Mugar Memorial Library · {day ? weekdayName(day.date) : 'Tuesday'} {hourLabel(HERO_HOUR)}
          </p>
          <dl className={styles.evidenceList}>
            <div>
              <dt>Opening hours</dt>
              <dd>
                7 AM – 2 AM<span className={styles.published}>Published</span>
              </dd>
            </div>
            <div>
              <dt>Class meetings in the building today</dt>
              <dd>
                5<span className={styles.published}>Published</span>
              </dd>
            </div>
            <div>
              <dt>Projected occupancy</dt>
              <dd>
                {share != null ? (
                  <span className={styles.mockReadingPlain}>
                    <Dot share={share} size="sm" />
                    {reading(share)}
                  </span>
                ) : (
                  '…'
                )}
                <span className={styles.modeled}>Modeled</span>
              </dd>
            </div>
            <div>
              <dt>Busiest hour</dt>
              <dd>
                {busiest != null ? hourLabel(busiest) : '…'}
                <span className={styles.modeled}>Modeled</span>
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}

/* ---------- 06 Privacy ---------- */

function PrivacySection() {
  return (
    <section id="privacy" tabIndex={-1} className={`${styles.section} ${styles.sectionAlt}`} aria-labelledby="privacy-title">
      <div className={styles.container}>
        <p className={styles.eyebrow}>Privacy</p>
        <h2 id="privacy-title" className={`${styles.sectionTitle} ${styles.narrowTitle}`}>
          Built only on public data.
        </h2>
        <div className={styles.promises}>
          <div>
            <h3>Public data only</h3>
            <p>Schedules, classroom seat counts, building hours and events all come from public pages, nearly all of them BU’s.</p>
          </div>
          <div>
            <h3>No personal data in the model</h3>
            <p>The 36,977 students in the model are synthetic. No real student’s schedule, location or identity goes into it.</p>
          </div>
          <div>
            <h3>Private events skipped</h3>
            <p>Events that aren’t publicly listed are left out of the simulation.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------- 07 Closing ---------- */

function Closing({ day }: { day: DayForecast | null }) {
  const shareOf = useCallback((place: string) => day?.share(place, 18) ?? null, [day]);
  return (
    <section className={`${styles.dark} ${styles.closing}`} data-theme="dark" aria-labelledby="closing-title">
      <div className={styles.closingText}>
        <h2 id="closing-title" className={styles.closingTitle}>
          Know before you go.
        </h2>
        <p className={styles.closingLede}>Check the next few hours for any of 101 places on campus.</p>
        <div className={styles.closingActions}>
          <a href={config.mapUrl} className={`${styles.cta} ${styles.ctaLarge}`}>
            Open the map
          </a>
        </div>
      </div>
      <div className={styles.closingScene} style={{ '--scene-opacity': 0.75 } as CSSProperties}>
        <CampusScene shareOf={shareOf} scale={0.8} dy={40} />
      </div>
    </section>
  );
}
