import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { Maximize2, Menu, X } from 'lucide-react';
import { Link } from 'react-router';
import { AnimatePresence, motion, MotionConfig, useMotionValueEvent, useReducedMotion, useScroll, useTransform, type MotionValue } from 'motion/react';
import { crowdFor, crowdScale } from '@theme/tokens';
import { loadCampusData, type CampusData } from '@map/data/campusData';
import { config } from '../config';
import { Logo } from '../ui/Logo';
import { api, useResource } from '../data/api';
import { formatPercent } from '../lib/format';
import { introSources, presetNow } from '@map/intro';
import { IntroSky } from '@map/IntroSky';
import type { EventImpactData, ImpactPlace } from '../data/types';
import { openMap, prepareMap, STILL_ATTR } from './landing/openMap';
import { entrance, grow, item, reveal, rise, rule, stagger } from './landing/motion';
import { scrollToElement, scrollToY, setSmoothScrollPaused, useSmoothScroll } from './landing/smoothScroll';
import { bostonStamp, loadStudentCount } from './landing/status';
import {
  HOURS,
  FIRST_HOUR,
  LAST_HOUR,
  dayForecast,
  hourLabel,
  longDate,
  peaks,
  placesOfKind,
  weekdayName,
  type DayForecast,
} from './landing/forecast';
import styles from './Landing.module.css';

/**
 * The public front page: signed-out visitors see it at /, and anyone at /landing. Always dark: near
 * black and flat. Every number comes from the model's data (forecast.ts, status.ts).
 */

const SECTIONS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'how', label: 'How it works' },
  { id: 'faq', label: 'FAQ' },
] as const;

const GITHUB_URL = 'https://github.com/Darkest-Teddy/Flowcast';

/** The hour the hero's cards and the preview open on. */
const HERO_HOUR = 18;

/** The kinds of place the hourly preview cycles through. */
const CATEGORIES = [
  { kind: 'dining', label: 'Dining' },
  { kind: 'library', label: 'Libraries' },
  { kind: 'gym', label: 'Gyms' },
] as const;
const KIND_LABEL: Record<string, string> = { library: 'Library', dining: 'Dining hall', gym: 'Gym', classroom: 'Academic building', dorm: 'Residence' };

/** The dashboard's home screen for the product frame (docs/images/dashboard-home.jpg, 1440×900, as WebP). */
const DASHBOARD_SHOT = '/landing/dashboard-home.webp';

/**
 * The forecast: the dashboard API's, or, when the API isn't up (local development without the
 * database), the same published data as a static file, so every section has real numbers.
 */
function loadImpact(): Promise<EventImpactData> {
  return api.getEventImpact().catch(async (error) => {
    const response = await fetch('/data/event-impact.json');
    if (!response.ok) throw error;
    return (await response.json()) as EventImpactData;
  });
}

/** Scrolls to a section (eased unless reduced motion is on), moves focus there and updates the address. */
function goToSection(event: MouseEvent<HTMLAnchorElement>, id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  event.preventDefault();
  scrollToElement(target);
  target.focus({ preventScroll: true });
  window.history.replaceState(window.history.state, '', `#${id}`);
}

/** "Busy 71%": the crowd level always as a word and a percentage, never colour alone. */
const reading = (share: number) => `${crowdFor(share).label} ${formatPercent(share)}`;

function Dot({ share, size = 'md' }: { share: number; size?: 'sm' | 'md' | 'lg' }) {
  return <span className={`${styles.dot} ${styles[`dot-${size}`]}`} style={{ background: crowdFor(share).color }} aria-hidden />;
}

/** "under 40%", "40–65%", "85%+". */
function legendRange(i: number) {
  const from = i > 0 ? Math.round(crowdScale[i - 1].upTo * 100) : 0;
  const to = crowdScale[i].upTo;
  if (i === 0) return `under ${Math.round(to * 100)}%`;
  if (!Number.isFinite(to)) return `${from}%+`;
  return `${from}–${Math.round(to * 100)}%`;
}

export default function Landing() {
  useSmoothScroll();
  const impact = useResource(loadImpact);
  const sources = useResource(loadCampusData);
  const students = useResource(loadStudentCount);
  const day = useMemo(() => (impact.data ? dayForecast(impact.data) : null), [impact.data]);
  // The view from the sky in the light the map opens in now: the same picture, haze and clouds the
  // map's loading screen starts from (map-client/src/intro.ts).
  const [preset] = useState(presetNow);
  const still = introSources(preset);

  useEffect(() => {
    const previous = document.title;
    document.title = 'Flowcast · Crowd forecasts for Boston University';
    return () => {
      document.title = previous;
    };
  }, []);

  // A link straight to a section (/landing#faq): the sections render with the page, so jump there once.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    const target = id ? document.getElementById(id) : null;
    if (target) scrollToElement(target, { immediate: true });
  }, []);

  const navAway = useAwayOnScrollDown();
  const status = <StatusStrip sources={sources.data} students={students.data} />;
  return (
    <MotionConfig reducedMotion="user">
      <div className={styles.page} data-theme="dark">
        <a className={styles.skip} href="#main">
          Skip to content
        </a>
        <LandingNav away={navAway} />
        <main id="main" tabIndex={-1} className={styles.main}>
          <Hero preset={preset} still={still} />
          <Dashboard />
          <Preview day={day} error={impact.error} reload={impact.reload} />
          <HowItWorks sources={sources.data} />
          <Faq />
          <Closing still={still} />
        </main>
        <footer className={styles.footer}>
          {status}
          <div className={styles.footerRow}>
            <span>Flowcast · Built at Hackachusetts, Civic Action track.</span>
            <a href={GITHUB_URL}>GitHub</a>
          </div>
        </footer>
      </div>
    </MotionConfig>
  );
}

/* ---------- Top bars ---------- */

/**
 * True while the nav should be out of the way: scrolling down past the top of the page sends it up,
 * any scroll back up brings it down again. Keyboard focus inside it keeps it in.
 */
function useAwayOnScrollDown() {
  const [away, setAway] = useState(false);
  useEffect(() => {
    let last = window.scrollY;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const y = window.scrollY;
        const delta = y - last;
        if (Math.abs(delta) < 6) return; // small jitters (and Lenis' easing tail) don't flip it
        const focusInside = document.activeElement?.closest('header') != null;
        setAway(delta > 0 && y > 120 && !focusInside);
        last = y;
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);
  return away;
}

/* ---------- Status strip ---------- */

/** The time in Boston, ticking over each minute. */
function useBostonClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** One thin monospace line above the footer, after a GIS status bar: the time in Boston and the model's own counts. Phones keep the time. */
function StatusStrip({ sources, students }: { sources: CampusData | null; students: number | null }) {
  const now = useBostonClock();
  const counts = [
    students != null && `${students.toLocaleString('en-US')} students simulated`,
    sources && `${sources.coverage.mappedMeetings.toLocaleString('en-US')} class meetings`,
    sources && `${sources.term} schedule`,
  ].filter((text): text is string => Boolean(text));
  return (
    <div className={styles.strip}>
      <ul aria-label="Model status">
        <li>
          <time dateTime={now.toISOString()}>{bostonStamp(now)}</time>
        </li>
        {counts.map((text) => (
          <li key={text} className={styles.stripExtra}>
            {text.toUpperCase()}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------- Nav ---------- */

function LandingNav({ away }: { away: boolean }) {
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
    <header className={`${styles.navBar} ${away && !open ? styles.chromeAway : ''}`}>
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

function Hero({ preset, still }: { preset: ReturnType<typeof presetNow>; still: ReturnType<typeof introSources> }) {
  // Once the still is up, ready the map behind the scenes (prepareMap), so its downloads are done by the click.
  const [stillUp, setStillUp] = useState<HTMLImageElement | null>(null);
  useEffect(() => (stillUp ? prepareMap(stillUp) : undefined), [stillUp]);

  // Scrolling away, the words drift up and fade before the picture leaves.
  const heroRef = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: heroRef, offset: ['start start', 'end start'] });
  const textY = useTransform(scrollYProgress, [0, 1], [0, -140]);
  const textOpacity = useTransform(scrollYProgress, [0, 0.55], [1, 0]);

  return (
    <section ref={heroRef} id="top" tabIndex={-1} className={styles.hero} aria-labelledby="hero-title">
      <motion.div {...entrance} className={styles.heroText} style={reduce ? undefined : { y: textY, opacity: textOpacity }}>
        <motion.h1 {...item} id="hero-title" className={styles.heroTitle}>
          See how busy campus is before you go.
        </motion.h1>
        <motion.p {...item} className={styles.heroLede}>
          Hourly crowd forecasts for BU’s libraries, dining halls and gyms.
        </motion.p>
        <motion.div {...item} className={styles.heroActions}>
          <a href={config.mapUrl} onClick={openMap} className={`${styles.cta} ${styles.ctaLarge}`}>
            Open the map
          </a>
          <Link to="/signin" className={`${styles.ghostCta} ${styles.ctaLarge}`}>
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

/* ---------- Shared section head ---------- */

/** An eyebrow, a 3–6 word headline and a one-line subline, coming into focus as they scroll in. */
function SectionHead({ id, eyebrow, title, sub, align = 'start' }: { id: string; eyebrow: string; title: string; sub: string; align?: 'start' | 'center' | 'split' }) {
  return (
    <div className={`${styles.sectionHead} ${styles[`head-${align}`]}`}>
      <div>
        <motion.p {...reveal} className={styles.eyebrow}>
          {eyebrow}
        </motion.p>
        <motion.h2 {...reveal} id={id} className={styles.sectionTitle}>
          {title}
        </motion.h2>
      </div>
      <motion.p {...reveal} className={styles.subline}>
        {sub}
      </motion.p>
    </div>
  );
}

/** A two-tone headline, after raycast.com: the title in ink, then a sentence in grey on the same run. */
function TwoTone({ id, title, rest, className = '' }: { id: string; title: string; rest: string; className?: string }) {
  return (
    <motion.h2 {...reveal} id={id} className={`${styles.twoTone} ${className}`}>
      {title} <span>{rest}</span>
    </motion.h2>
  );
}

/* ---------- 02 Dashboard ---------- */

function Dashboard() {
  const reduce = useReducedMotion();
  // The frame tilts up into place as it scrolls in, after Raycast's product window.
  const frameRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: frameRef, offset: ['start end', 'center center'] });
  const rotateX = useTransform(scrollYProgress, [0, 1], [16, 0]);
  const scale = useTransform(scrollYProgress, [0, 1], [0.92, 1]);

  return (
    <section id="dashboard" tabIndex={-1} className={styles.section} aria-labelledby="dashboard-title">
      <div className={styles.container}>
        <TwoTone id="dashboard-title" title="Your day, around the crowds." rest="Your classes, how busy your places will be, and when to go." className={`${styles.centerTwoTone} ${styles.wideCenter}`} />
        <div className={styles.frameStage}>
          <motion.div ref={frameRef} className={styles.videoFrame} style={reduce ? undefined : { rotateX, scale }}>
            <img
              src={DASHBOARD_SHOT}
              width={1440}
              height={900}
              alt="The Flowcast dashboard's home screen: today's classes, how busy your places will be, a suggestion for when to go, and this week's numbers"
              loading="lazy"
            />
          </motion.div>
        </div>
      </div>
    </section>
  );
}

/* ---------- 03 Hourly preview ---------- */

function Preview({ day, error, reload }: { day: DayForecast | null; error: Error | null; reload: () => void }) {
  const [category, setCategory] = useState(0);
  const [placeIndex, setPlaceIndex] = useState(0);
  const [hour, setHour] = useState(HERO_HOUR);
  const places = useMemo(() => (day ? placesOfKind(day, CATEGORIES[category].kind, 4) : []), [day, category]);

  return (
    <section id="preview" tabIndex={-1} className={styles.section} aria-labelledby="preview-title">
      <div className={styles.container}>
        <TwoTone id="preview-title" title="Plan around the rush." rest={`Pick a place, then an hour${day ? `, for ${longDate(day.date)}` : ''}.`} className={styles.wideTwoTone} />
        {/* An app window around the preview, after raycast.com's product frames: a title bar holding the filter. */}
        <motion.div {...rise} viewport={{ once: true, amount: 0.2 }} className={styles.appWindow}>
          <div className={styles.appBar}>
            <span className={styles.appDots} aria-hidden>
              <span />
              <span />
              <span />
            </span>
            <span className={styles.appTitle}>Hourly forecast · modeled, not live</span>
          {/* Which places the preview cycles through: a segmented control, after Raycast's category tabs. */}
          <div role="group" aria-label="Kind of place" className={styles.segmented}>
            {CATEGORIES.map((c, i) => (
              <button
                key={c.kind}
                type="button"
                aria-pressed={i === category}
                className={styles.segment}
                onClick={() => {
                  setCategory(i);
                  setPlaceIndex(0);
                }}
              >
                {c.label}
              </button>
            ))}
          </div>
          </div>
          <div className={styles.appBody}>
          {day ? (
            <PreviewBody day={day} places={places} placeIndex={placeIndex} setPlaceIndex={setPlaceIndex} hour={hour} setHour={setHour} />
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
        </motion.div>
      </div>
    </section>
  );
}

function PreviewBody({
  day,
  places,
  placeIndex,
  setPlaceIndex,
  hour,
  setHour,
}: {
  day: DayForecast;
  places: ImpactPlace[];
  placeIndex: number;
  setPlaceIndex: (i: number) => void;
  hour: number;
  setHour: (h: number) => void;
}) {
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

  if (!place) return <p className={styles.previewStatus}>No forecast data is available for these places.</p>;

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
              {crowdScale.slice(0, -1).map((s) => (
                <div key={s.level} className={styles.threshold} style={{ bottom: `${s.upTo * 100}%` }} aria-hidden>
                  <span>{formatPercent(s.upTo)}</span>
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

/* ---------- 04 How it works ---------- */

/** Wide windows with motion allowed: the steps pin and open one by one as the page scrolls. Matches Landing.module.css. */
const PINNED = '(min-width: 900px) and (prefers-reduced-motion: no-preference)';

interface StepShot {
  /** map-client/public/landing/how-<name>-<1x|2x>.webp: the map in a 1280 × 800 window, at 1× and 2×. */
  name: string;
  alt: string;
  caption: string;
}

/** Each step's screenshot of the real map, whole, at the shape it was taken. */
const HOW_SHOTS: StepShot[] = [
  {
    name: 'sources',
    alt: "The Flowcast map with its Analytics panel open, listing BU buildings and how many classes each holds, beside the campus with a crowd tag on every building",
    caption: 'BU’s class schedules, building by building',
  },
  {
    name: 'day',
    alt: 'The 3D map close up on Commonwealth Avenue in the early afternoon: simulated students walking between buildings, each tagged with how full it is, and the clock at the top right',
    caption: 'Simulated students walking between classes',
  },
  {
    name: 'forecast',
    alt: 'The 3D map of the Charles River Campus with a crowd tag on every building, such as CDS Busy 84% seats, and the Analytics panel listing the quietest places right now',
    caption: 'Every building’s crowd level, on one scale',
  },
];

const SHOT_SIZE = { width: 2560, height: 1600 };
const shotSources = (shot: StepShot) => ({
  src: `/landing/how-${shot.name}-1x.webp`,
  srcSet: `/landing/how-${shot.name}-1x.webp 1280w, /landing/how-${shot.name}-2x.webp 2560w`,
});

function useMatches(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const sync = () => setMatches(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, [query]);
  return matches;
}

/**
 * The three steps, played as you scroll, after apple.com's feature walls: the section holds still
 * for a few screens while each step lights in turn, and the window beside it shows that step in the
 * real map. The steps split the window's height into equal thirds, so the two columns line up.
 * Clicking a step scrolls to it; clicking a screenshot opens it full size. On narrow screens and
 * with reduced motion nothing pins: the steps stack, each screenshot under its words.
 */
function HowItWorks({ sources }: { sources: CampusData | null }) {
  const meetings = sources ? `${sources.coverage.mappedMeetings.toLocaleString('en-US')} class meetings` : 'Class meetings';
  const events = sources ? `${sources.events.length.toLocaleString('en-US')} campus events` : 'campus events';
  const steps = [
    { title: 'Public BU data', body: `${meetings}, ${events}, posted hours and published seat counts.`, shot: HOW_SHOTS[0] },
    { title: 'A simulated day', body: 'Synthetic students follow class schedules and walk between buildings, eating and studying within posted hours.', shot: HOW_SHOTS[1] },
    { title: 'Hourly forecasts', body: 'Each modeled place gets an occupancy for every hour, as a share of its capacity, on one scale.', shot: HOW_SHOTS[2] },
  ];

  const trackRef = useRef<HTMLElement>(null);
  const pinned = useMatches(PINNED);
  const { scrollYProgress } = useScroll({ target: trackRef, offset: ['start start', 'end end'] });
  const [active, setActive] = useState(0);
  useMotionValueEvent(scrollYProgress, 'change', (p) => setActive(Math.max(0, Math.min(steps.length - 1, Math.floor(p * steps.length)))));

  /** Scrolls to just inside step i's stretch of the track, which lights it. */
  function open(i: number) {
    const track = trackRef.current;
    if (!track) return;
    const top = track.getBoundingClientRect().top + window.scrollY;
    scrollToY(top + (track.offsetHeight - window.innerHeight) * ((i + 0.08) / steps.length));
  }

  const [zoomed, setZoomed] = useState<StepShot | null>(null);

  return (
    <section ref={trackRef} id="how" tabIndex={-1} className={styles.howTrack} aria-labelledby="how-title">
      <div className={styles.howPin}>
        <div className={styles.container}>
          <TwoTone id="how-title" title="Schedules in, forecasts out." rest="Three steps from public pages to the map." className={styles.howTitle} />
          <div className={styles.howGrid}>
            <ol className={styles.howSteps}>
              {steps.map((step, i) => (
                <HowStep key={step.title} index={i} count={steps.length} step={step} active={i === active} pinned={pinned} progress={scrollYProgress} onOpen={open} onZoom={setZoomed} />
              ))}
            </ol>
            {pinned && (
              <div className={styles.howStage}>
                <AnimatePresence initial={false}>
                  <motion.div
                    key={active}
                    className={styles.howVisual}
                    initial={{ opacity: 0, scale: 1.03 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.98 }}
                    transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                  >
                    <Shot shot={steps[active].shot} onZoom={setZoomed} />
                  </motion.div>
                </AnimatePresence>
              </div>
            )}
          </div>
        </div>
      </div>
      <Lightbox shot={zoomed} onClose={() => setZoomed(null)} />
    </section>
  );
}

/**
 * One step: its numeral, title and words, always shown. While pinned, the step on screen is lit and
 * a bar down its left edge fills across its stretch of the scroll; the others are dimmed, and
 * clicking one scrolls to it.
 */
function HowStep({
  index,
  count,
  step,
  active,
  pinned,
  progress,
  onOpen,
  onZoom,
}: {
  index: number;
  count: number;
  step: { title: string; body: string; shot: StepShot };
  active: boolean;
  pinned: boolean;
  progress: MotionValue<number>;
  onOpen: (i: number) => void;
  onZoom: (shot: StepShot) => void;
}) {
  const fill = useTransform(progress, [index / count, (index + 1) / count], [0, 1]);
  const numeral = (
    <span className={styles.num} aria-hidden>
      {String(index + 1).padStart(2, '0')}
    </span>
  );
  return (
    <li className={styles.howStep} data-active={(pinned && active) || undefined} aria-current={pinned && active ? 'step' : undefined}>
      {pinned && <motion.span className={styles.howStepFill} style={{ scaleY: fill }} aria-hidden />}
      <h3 className={styles.howStepTitle}>
        {pinned ? (
          <button type="button" className={styles.howStepButton} onClick={() => onOpen(index)}>
            {numeral}
            {step.title}
          </button>
        ) : (
          <span className={styles.howStepButton}>
            {numeral}
            {step.title}
          </span>
        )}
      </h3>
      <p className={styles.howStepText}>{step.body}</p>
      {!pinned && (
        <div className={styles.howInline}>
          <Shot shot={step.shot} onZoom={onZoom} />
        </div>
      )}
    </li>
  );
}

/** A step's screenshot in the same rounded window as the dashboard frame; clicking it opens the lightbox. */
function Shot({ shot, onZoom }: { shot: StepShot; onZoom: (shot: StepShot) => void }) {
  return (
    <button type="button" className={styles.howShot} onClick={() => onZoom(shot)} aria-label={`${shot.caption}: open full size`}>
      <img {...shotSources(shot)} {...SHOT_SIZE} sizes="(min-width: 900px) 880px, 100vw" alt={shot.alt} loading="lazy" />
      <span className={styles.howShotZoom} aria-hidden>
        <Maximize2 />
      </span>
    </button>
  );
}

/**
 * A screenshot full size over the page (a modal <dialog>: focus stays inside, Escape closes it).
 * Clicking anywhere but the picture closes it too. The page's smooth scrolling pauses meanwhile.
 */
function Lightbox({ shot, onClose }: { shot: StepShot | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (shot && !dialog.open) {
      dialog.showModal();
      setSmoothScrollPaused(true);
    } else if (!shot && dialog.open) dialog.close();
  }, [shot]);

  return (
    <dialog
      ref={ref}
      className={styles.lightbox}
      aria-label={shot?.caption}
      onClose={() => {
        setSmoothScrollPaused(false);
        onClose();
      }}
      onClick={(e) => {
        if (!(e.target instanceof HTMLImageElement)) ref.current?.close();
      }}
    >
      {shot && (
        <figure className={styles.lightboxFigure}>
          <img {...shotSources(shot)} {...SHOT_SIZE} sizes="100vw" alt={shot.alt} />
          <figcaption>{shot.caption}</figcaption>
        </figure>
      )}
      <button type="button" className={styles.lightboxClose} aria-label="Close">
        <X aria-hidden />
      </button>
    </dialog>
  );
}

/* ---------- 05 FAQ ---------- */

/** The page's transparency and privacy statements, as questions. Every claim the old sections made is here. */
const FAQ = [
  {
    q: 'Is this real data?',
    a: 'The crowd levels are projections from a simulation, not measurements of real students. It assumes, for example, that students attend their scheduled classes and eat during posted dining hours.',
  },
  {
    q: 'Does Flowcast track me?',
    a: 'No. The students in the campus model are synthetic, and the model does not track real students’ locations or identities.',
  },
  {
    q: 'Where do the numbers come from?',
    a: 'Public pages, nearly all of them BU’s: class schedules, classroom seat counts, building hours and events. The map’s Data tab shows each building’s class schedules and opening hours.',
  },
  {
    q: 'What about private events?',
    a: 'Events that aren’t publicly listed are left out of the simulation.',
  },
  {
    q: 'What do the crowd levels mean?',
    a: `Each is a share of a place’s capacity: ${crowdScale.map((s, i) => `${s.label} ${legendRange(i)}`).join(', ')}. Places or hours without simulation data show as unavailable.`,
  },
];

function Faq() {
  return (
    <section id="faq" tabIndex={-1} className={styles.section} aria-labelledby="faq-title">
      <div className={`${styles.container} ${styles.faqGrid}`}>
        <div className={styles.faqSide}>
          <SectionHead id="faq-title" eyebrow="FAQ" title="Questions, answered." sub="What the forecasts are, and what they aren’t." />
        </div>
        <motion.ol {...stagger} className={styles.faqList}>
          {FAQ.map((entry, i) => (
            <motion.li key={entry.q} {...item}>
              <motion.span {...rule} className={styles.rule} aria-hidden />
              <h3 className={styles.faqQuestion}>
                <span className={styles.num} aria-hidden>
                  {String(i + 1).padStart(2, '0')}
                </span>
                {entry.q}
              </h3>
              <p className={styles.faqAnswer}>{entry.a}</p>
            </motion.li>
          ))}
        </motion.ol>
      </div>
    </section>
  );
}

/* ---------- 06 Closing ---------- */

function Closing({ still }: { still: ReturnType<typeof introSources> }) {
  return (
    <section className={`${styles.section} ${styles.closing}`} aria-labelledby="closing-title">
      <div className={styles.closingBand}>
        <img className={styles.closingStill} {...still} sizes="100vw" alt="" loading="lazy" aria-hidden />
        <motion.div {...stagger} className={styles.closingText}>
          <motion.h2 {...item} id="closing-title" className={styles.closingTitle}>
            Beat the rush.
          </motion.h2>
          <motion.p {...item} className={styles.subline}>
            Check the next few hours before you head out.
          </motion.p>
          <motion.div {...item} className={styles.closingActions}>
            <a href={config.mapUrl} onClick={openMap} className={`${styles.cta} ${styles.ctaLarge}`}>
              Open the map
            </a>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}
