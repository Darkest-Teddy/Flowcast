import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { Menu, X } from 'lucide-react';
import { Link } from 'react-router';
import { motion, MotionConfig, useReducedMotion, useScroll, useTransform } from 'motion/react';
import { crowdFor, crowdScale } from '@theme/tokens';
import { loadCampusData, openingHoursForDate, type CampusData } from '@map/data/campusData';
import { config } from '../config';
import { Logo } from '../ui/Logo';
import { api, useResource } from '../data/api';
import { formatPercent } from '../lib/format';
import { CampusScene } from './landing/CampusScene';
import { introSources, presetNow } from '@map/intro';
import { IntroSky } from '@map/IntroSky';
import { openMap, prepareMap, STILL_ATTR } from './landing/openMap';
import { entrance, grow, item, rise, rule, stagger, unveil } from './landing/motion';
import { scrollToElement, useSmoothScroll } from './landing/smoothScroll';
import {
  HOURS,
  FIRST_HOUR,
  LAST_HOUR,
  clockLabel,
  dayForecast,
  eventExample,
  hourLabel,
  longDate,
  peaks,
  shortDate,
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
const PREVIEW_PLACES = ['mugar', 'warren-dining', 'fitrec'];
const KIND_LABEL: Record<string, string> = { library: 'Library', dining: 'Dining hall', gym: 'Gym', classroom: 'Academic building', dorm: 'Residence' };

/** Scrolls to a section (eased unless reduced motion is on), moves focus there and updates the address. */
function goToSection(event: MouseEvent<HTMLAnchorElement>, id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  event.preventDefault();
  scrollToElement(target);
  target.focus({ preventScroll: true });
  window.history.replaceState(window.history.state, '', `#${id}`);
}

/** "Busy 71%". */
const reading = (share: number) => `${crowdFor(share).label} ${formatPercent(share)}`;

function Dot({ share, size = 'md' }: { share: number; size?: 'sm' | 'md' | 'lg' }) {
  return <span className={`${styles.dot} ${styles[`dot-${size}`]}`} style={{ background: crowdFor(share).color }} aria-hidden />;
}

export default function Landing() {
  useSmoothScroll();
  const impact = useResource(api.getEventImpact);
  const sources = useResource(loadCampusData);
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
    const target = id ? document.getElementById(id) : null;
    if (target) scrollToElement(target, { immediate: true });
  }, []);

  return (
    <MotionConfig reducedMotion="user">
      <div className={styles.page}>
        <a className={styles.skip} href="#main">
          Skip to content
        </a>
        <LandingNav />
        <main id="main" tabIndex={-1} className={styles.main}>
          <Hero />
          <Preview day={day} error={impact.error} reload={impact.reload} />
          <HowItWorks sources={sources.data} />
          <Features day={day} event={event} />
          <Transparency day={day} sources={sources.data} />
          <PrivacySection />
          <Closing day={day} />
        </main>
        <footer className={`${styles.dark} ${styles.footer}`} data-theme="dark">
          <div className={styles.footerRow}>
            <span>Flowcast · Built at Hackachusetts, Civic Action track.</span>
            <a href={GITHUB_URL}>GitHub</a>
          </div>
        </footer>
      </div>
    </MotionConfig>
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
          <a href={config.mapUrl} onClick={openMap} className={`${styles.cta} ${styles.navCta}`}>
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

function Hero() {
  // The view from the sky in the light the map opens in now: the same picture, haze and clouds the
  // map's loading screen starts from (map-client/src/intro.ts).
  const [preset] = useState(presetNow);
  const still = introSources(preset);
  // Once the still is up, start the map behind the scenes (prepareMap), so it opens ready or nearly.
  const [stillUp, setStillUp] = useState<HTMLImageElement | null>(null);
  useEffect(() => (stillUp ? prepareMap(config.mapUrl, stillUp) : undefined), [stillUp]);

  // Scrolling away, the words drift up and fade before the picture leaves.
  const heroRef = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: heroRef, offset: ['start start', 'end start'] });
  const textY = useTransform(scrollYProgress, [0, 1], [0, -140]);
  const textOpacity = useTransform(scrollYProgress, [0, 0.55], [1, 0]);

  return (
    <section
      ref={heroRef}
      id="top"
      tabIndex={-1}
      className={`${styles.dark} ${styles.hero}`}
      data-theme="dark"
      aria-labelledby="hero-title"
    >
      <motion.div {...entrance} className={styles.heroText} style={reduce ? undefined : { y: textY, opacity: textOpacity }}>
        <motion.p {...item} className={styles.heroEyebrow}>
          Crowd forecasts for Boston University
        </motion.p>
        <motion.h1 {...item} id="hero-title" className={styles.heroTitle}>
          See how busy campus is before you go.
        </motion.h1>
        <motion.p {...item} className={styles.heroLede}>
          Flowcast forecasts how full BU’s libraries, dining halls and gyms will be, hour by hour, from the published Fall 2026 class
          schedule.
        </motion.p>
        <motion.div {...item} className={styles.heroActions}>
          <a href={config.mapUrl} onClick={openMap} className={`${styles.cta} ${styles.ctaLarge}`}>
            Open the map
          </a>
          <Link to="/signin" className={`${styles.glassCta} ${styles.ctaLarge}`}>
            Continue with Google
          </Link>
        </motion.div>
      </motion.div>

      <div className={styles.stage}>
        <img
          className={styles.heroStill}
          {...still}
          {...{ [STILL_ATTR]: '' }}
          sizes="100vw"
          alt="Boston University's campus along the Charles River on the Flowcast map, seen from above through cloud"
          fetchPriority="high"
          onLoad={(e) => setStillUp(e.currentTarget)}
        />
        <IntroSky light={preset} />
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
        <motion.h2 {...rise} id="preview-title" className={styles.sectionTitle}>
          Plan around the rush.
        </motion.h2>
        <motion.p {...rise} className={styles.previewLede}>
          Pick a place, then an hour, to see its simulation{day ? ` for ${longDate(day.date)} (${day.date})` : ''}. These are modeled crowds, not live measurements.
        </motion.p>
        <motion.div {...rise} viewport={{ once: true, amount: 0.25 }}>
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
        </motion.div>
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
  const share = place ? day.share(place.id, hour) : null;
  const level = share == null ? null : crowdFor(share);
  const { busiest, quietest } = peaks(day, place?.id ?? '');
  const at = (h: number) => day.share(place.id, h);
  const reduce = useReducedMotion();

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

  if (!place) return <p className={styles.previewStatus}>No forecast data is available for the preview places.</p>;

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
              {p.id === place.id && <motion.span layoutId="place-tab" className={styles.placeTabMark} aria-hidden />}
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
            {share != null && <Dot share={share} size="lg" />}
            <span>{share != null ? formatPercent(share) : 'Unavailable'}</span>
          </p>
          <p className={styles.previewLevel}>{level?.label ?? 'No projection for this hour'}</p>
          <p className={styles.previewSummary}>
            {busiest != null && quietest != null
              ? `Among available hours: busiest at ${hourLabel(busiest)} (${formatPercent(at(busiest)!)}). Quietest at ${hourLabel(quietest)} (${formatPercent(at(quietest)!)}).`
              : 'No hourly projections available.'}
          </p>
        </div>
        <div className={styles.chart}>
          <motion.div {...stagger} className={styles.plot}>
            <motion.div {...(reduce ? {} : grow)} className={styles.plotLayer}>
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
                aria-valuetext={`${hourLabel(hour)}: ${share != null ? `${level?.label}, ${formatPercent(share)}` : 'Unavailable'}`}
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
                      {s != null && <span className={styles.bar} style={{ height: `${Math.max(2, Math.min(100, s * 100))}%`, background: crowdFor(s).color }} />}
                    </span>
                  );
                })}
              </div>
            </motion.div>
          </motion.div>
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

function HowItWorks({ sources }: { sources: CampusData | null }) {
  return (
    <section id="how" tabIndex={-1} className={`${styles.section} ${styles.howSection}`} aria-labelledby="how-title">
      <div className={styles.container}>
        <motion.p {...rise} className={styles.eyebrow}>How it works</motion.p>
        <motion.h2 {...rise} id="how-title" className={`${styles.sectionTitle} ${styles.narrowTitle}`}>
          From public schedules to hourly forecasts.
        </motion.h2>
        <motion.ol {...stagger} className={styles.steps}>
          <motion.li {...item} className={styles.step}>
            <motion.span {...rule} className={styles.rule} aria-hidden />
            <div className={styles.stepHead}>
              <span className={styles.stepNumber} aria-hidden>
                01
              </span>
              <h3 className={styles.stepTitle}>Public BU data snapshot</h3>
            </div>
            <dl className={styles.facts}>
              <div>
                <dt>Mapped class meeting records</dt>
                <dd>{sources?.coverage.mappedMeetings.toLocaleString() ?? 'Unavailable'}</dd>
              </div>
              <div>
                <dt>Classroom capacities</dt>
                <dd className={styles.factWord}>Published seats</dd>
              </div>
              <div>
                <dt>Campus events</dt>
                <dd>{sources?.events.length.toLocaleString() ?? 'Unavailable'}</dd>
              </div>
              <div>
                <dt>Dining, library and gym hours</dt>
                <dd className={styles.factWord}>Posted</dd>
              </div>
            </dl>
          </motion.li>
          <motion.li {...item} className={styles.step}>
            <motion.span {...rule} className={styles.rule} aria-hidden />
            <div className={styles.stepHead}>
              <span className={styles.stepNumber} aria-hidden>
                02
              </span>
              <h3 className={styles.stepTitle}>Schedule-driven simulation</h3>
            </div>
            <div className={styles.bigFact}>
              <p className={styles.stepTitle}>Synthetic students</p>
              <p className={styles.muted}>Modeled activity, not tracked people</p>
            </div>
            <p className={styles.muted}>
              The model assigns class schedules and walking routes, with assumptions for meals, study and workouts within posted hours.
            </p>
          </motion.li>
          <motion.li {...item} className={styles.step}>
            <motion.span {...rule} className={styles.rule} aria-hidden />
            <div className={styles.stepHead}>
              <span className={styles.stepNumber} aria-hidden>
                03
              </span>
              <h3 className={styles.stepTitle}>Hourly forecasts on a map</h3>
            </div>
            <p className={styles.muted}>
              Places with simulation data show hourly projected occupancy as a share of capacity, on one scale. Missing data is unavailable.
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
          </motion.li>
        </motion.ol>
      </div>
    </section>
  );
}

/* ---------- 04 Features ---------- */

function Features({ day, event }: { day: DayForecast | null; event: EventExample | null }) {
  const reduce = useReducedMotion();
  const shareOf = useCallback((place: string) => day?.share(place, HERO_HOUR) ?? null, [day]);

  return (
    <section id="features" tabIndex={-1} className={`${styles.section} ${styles.sectionAlt}`} aria-labelledby="features-title">
      <div className={styles.container}>
        <motion.p {...rise} className={styles.eyebrow}>Features</motion.p>
        <motion.h2 {...rise} id="features-title" className={`${styles.sectionTitle} ${styles.narrowTitle}`}>
          See the campus, then plan the trip.
        </motion.h2>

        <div className={styles.featureLead}>
          <motion.div {...rise} className={styles.featureLeadText}>
            <h3 className={styles.featureTitleLarge}>3D campus map</h3>
            <p className={styles.featureBody}>
              Charles River, Fenway and Medical in one model. Each building is colored by how full it’s projected to be. Rotate, zoom,
              select any building for its classes and hours, and scrub the timeline to any hour.
            </p>
          </motion.div>
          <motion.div {...(reduce ? rise : unveil(24))} className={`${styles.dark} ${styles.featureVisual}`} data-theme="dark">
            <CampusScene shareOf={shareOf} scale={0.62} dx={-40} dy={10} />
          </motion.div>
        </div>

        <motion.div {...stagger} className={styles.featureList}>
          <motion.article {...item}>
            <motion.span {...rule} className={styles.rule} aria-hidden />
            <h3 className={styles.featureTitle}>Crowd forecasts</h3>
            <p className={styles.featureBody}>
              Pick a date and a place and see whether it will be quiet or packed, every hour from 7 AM to 11 PM.
            </p>
          </motion.article>
          <motion.article {...item}>
            <motion.span {...rule} className={styles.rule} aria-hidden />
            <h3 className={styles.featureTitle}>Event impact by date</h3>
            <p className={styles.featureBody}>
              Choose a date to see how scheduled campus events shift crowds in the buildings that host them.
              {event &&
                ` On ${shortDate(event.date)}, ${event.name} at ${event.venue.short} (${clockLabel(event.startSec)}) takes it from ${formatPercent(event.before)} to ${formatPercent(event.after)} at ${hourLabel(event.hour)}.`}
            </p>
          </motion.article>
          <motion.article {...item}>
            <motion.span {...rule} className={styles.rule} aria-hidden />
            <h3 className={styles.featureTitle}>Live MBTA, BU Shuttle and Bluebikes</h3>
            <p className={styles.featureBody}>
              Open the map to check MBTA and BU Shuttle arrivals and Bluebikes counts beside the crowds. Service data may be unavailable.
            </p>
          </motion.article>
          <motion.article {...item}>
            <motion.span {...rule} className={styles.rule} aria-hidden />
            <h3 className={styles.featureTitle}>What-if incidents</h3>
            <p className={styles.featureBody}>
              Add a fire drill, a building closure or an earthquake and see where the displaced crowd goes.
            </p>
          </motion.article>
        </motion.div>
      </div>
    </section>
  );
}

/* ---------- 05 Transparency ---------- */

function Transparency({ day, sources }: { day: DayForecast | null; sources: CampusData | null }) {
  const share = day?.share('mugar', HERO_HOUR) ?? null;
  const busiest = day ? peaks(day, 'mugar').busiest : null;
  const location = sources?.locations.mugar;
  const weekday = day ? (new Date(`${day.date}T12:00:00Z`).getUTCDay() + 6) % 7 : null;
  const hours = day && weekday != null && location
    ? openingHoursForDate(location.hours, day.date, weekday)
    : [];
  return (
    <section id="transparency" tabIndex={-1} className={styles.section} aria-labelledby="transparency-title">
      <div className={`${styles.container} ${styles.transparencyGrid}`}>
        <div>
          <motion.p {...rise} className={styles.eyebrow}>Transparency</motion.p>
          <motion.h2 {...rise} id="transparency-title" className={styles.sectionTitle}>
            Crowd levels are projections.
          </motion.h2>
          <motion.p {...rise} className={styles.transparencyBody}>
            Flowcast’s crowd levels come from a simulation built on stated assumptions, such as students attending their scheduled classes
            and eating during posted dining hours. They are not measurements of real students. The map’s Data tab shows each building’s class schedules and opening hours.
          </motion.p>
        </div>
        <motion.div {...stagger}>
          <motion.p {...item} className={styles.evidenceTitle}>
            Mugar Memorial Library · {day ? day.date : 'Date unavailable'} · {hourLabel(HERO_HOUR)}
          </motion.p>
          <dl className={styles.evidenceList}>
            <motion.div {...item}>
              <dt>Opening hours</dt>
              <dd>
                {hours.length ? hours.map((entry, i) => (
                  <span key={i}>
                    {entry.text}
                  </span>
                )) : 'Unavailable for this date'}
              </dd>
            </motion.div>
            <motion.div {...item}>
              <dt>Class schedules and source coverage</dt>
              <dd>
                <a href={config.mapUrl}>Inspect published schedules in the map’s Data tab</a>
              </dd>
            </motion.div>
            <motion.div {...item}>
              <dt>Projected occupancy</dt>
              <dd>
                {share != null ? (
                  <span className={styles.mockReadingPlain}>
                    <Dot share={share} size="sm" />
                    {reading(share)}
                  </span>
                ) : (
                  'Unavailable'
                )}
                <span className={styles.modeled}>Modeled</span>
              </dd>
            </motion.div>
            <motion.div {...item}>
              <dt>Busiest hour</dt>
              <dd>
                {busiest != null ? hourLabel(busiest) : 'Unavailable'}
                <span className={styles.modeled}>Modeled</span>
              </dd>
            </motion.div>
          </dl>
        </motion.div>
      </div>
    </section>
  );
}

/* ---------- 06 Privacy ---------- */

function PrivacySection() {
  return (
    <section id="privacy" tabIndex={-1} className={`${styles.section} ${styles.sectionAlt}`} aria-labelledby="privacy-title">
      <div className={styles.container}>
        <motion.p {...rise} className={styles.eyebrow}>Privacy</motion.p>
        <motion.h2 {...rise} id="privacy-title" className={`${styles.sectionTitle} ${styles.narrowTitle}`}>
          Built only on public data.
        </motion.h2>
        <motion.div {...stagger} className={styles.promises}>
          <motion.div {...item}>
            <motion.span {...rule} className={styles.rule} aria-hidden />
            <h3>Public data only</h3>
            <p>Schedules, classroom seat counts, building hours and events all come from public pages, nearly all of them BU’s.</p>
          </motion.div>
          <motion.div {...item}>
            <motion.span {...rule} className={styles.rule} aria-hidden />
            <h3>No personal data in the model</h3>
            <p>The students in the campus model are synthetic. The model does not track real students’ locations or identities.</p>
          </motion.div>
          <motion.div {...item}>
            <motion.span {...rule} className={styles.rule} aria-hidden />
            <h3>Private events skipped</h3>
            <p>Events that aren’t publicly listed are left out of the simulation.</p>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}

/* ---------- 07 Closing ---------- */

function Closing({ day }: { day: DayForecast | null }) {
  const shareOf = useCallback((place: string) => day?.share(place, 18) ?? null, [day]);
  return (
    <section className={`${styles.dark} ${styles.closing}`} data-theme="dark" aria-labelledby="closing-title">
      <motion.div {...stagger} className={styles.closingText}>
        <motion.h2 {...item} id="closing-title" className={styles.closingTitle}>
          Know before you go.
        </motion.h2>
        <motion.p {...item} className={styles.closingLede}>
          Explore hourly crowd projections for the campus’s modeled places.
        </motion.p>
        <motion.div {...item} className={styles.closingActions}>
          <a href={config.mapUrl} onClick={openMap} className={`${styles.cta} ${styles.ctaLarge}`}>
            Open the map
          </a>
        </motion.div>
      </motion.div>
      <motion.div
        initial={{ opacity: 0, y: 60 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.3 }}
        transition={{ duration: 1.4, ease: [0.22, 1, 0.36, 1] }}
        className={styles.closingScene}
        style={{ '--scene-opacity': 0.75 } as CSSProperties}
      >
        <CampusScene shareOf={shareOf} scale={0.8} dy={40} />
      </motion.div>
    </section>
  );
}
