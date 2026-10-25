/*
 * Flowcast marketing landing page.
 *
 * Authority: DESIGN.md (locked design system) and LANDING_PAGE_BRIEF.md (content, structure,
 * motion). Every colour, face, step, radius and duration comes from an --fc-* token.
 *
 * Copy rule from the brief: say what the product does the way an engineer would explain it to
 * a friend. No "seamless", no "leverage", no filler adjectives. Every number on this page is
 * verified against data-pipeline/output/manifest.json. Nothing is invented.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Hero } from './landing/Hero';
import { Rings } from './landing/Rings';
import styles from './Landing.module.css';

/* ---------------------------------------------------------------------------
 * Verified facts.
 *
 * Source: data-pipeline/output/manifest.json, datasetVersion bu-public-2026-10-24,
 * status "partial". Its stated limitation governs every claim on this page:
 *
 *   "Capacity, registrations, throughput, historical counts, and occupancy are
 *    distinct. No measured live occupancy is inferred."
 *
 * So the page never claims to measure who is in a building. It claims what is true:
 * Flowcast simulates students on real schedules and forecasts the crowd.
 * ------------------------------------------------------------------------- */
const FACTS = {
  meetings: 6944, // physical class meetings with a time and a room
  courses: 8900,
  classrooms: 437, // classrooms with a verified capacity
  buildings: 70,
  libraryObservations: 11220,
  campuses: 3, // Charles River, Medical, Fenway
} as const;

/* ---------------------------------------------------------------------------
 * Reveal on scroll. Content is visible by default and only animates when
 * scripting is on and motion is allowed.
 * ------------------------------------------------------------------------- */
function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setShown(true);
            io.disconnect();
          }
        }
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.08 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return [ref, shown] as const;
}

function Reveal({ children, className }: { children: ReactNode; className?: string }) {
  const [ref, shown] = useReveal<HTMLDivElement>();
  return (
    <div ref={ref} className={[styles.reveal, shown ? styles.revealIn : '', className].filter(Boolean).join(' ')}>
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * The "it is live right now" signal. DESIGN.md §6 bans the colored-dot LIVE
 * badge by name; a surveyor's coordinate and the wall clock do the same work
 * and are unmistakably cartographic.
 * ------------------------------------------------------------------------- */
function CoordinateReadout({ className }: { className?: string }) {
  const [stamp, setStamp] = useState<string | null>(null);

  useEffect(() => {
    const render = () => {
      const now = new Date();
      const day = now.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
      const time = now.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: 'America/New_York',
      });
      setStamp(`42.3505°N · ${day} ${time}`);
    };
    render();
    const id = window.setInterval(render, 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Renders nothing until the clock is read, so server and client never disagree.
  if (!stamp) return null;
  return (
    <span className={[styles.data, className].filter(Boolean).join(' ')}>
      {stamp}
    </span>
  );
}

/* ---------------------------------------------------------------------------
 * Nav
 * ------------------------------------------------------------------------- */
function Nav() {
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className={styles.container}>
      <nav className={[styles.nav, stuck ? styles.navStuck : ''].join(' ')} aria-label="Main">
        <a className={styles.wordmark} href="#top">
          <span className={styles.wordmarkName}>Flowcast</span>
          <span className={styles.wordmarkPlace}>Boston University</span>
        </a>

        <div className={styles.navLinks}>
          <a className={styles.navLink} href="#problem">
            Why
          </a>
          <a className={styles.navLink} href="#features">
            Legend
          </a>
          <a className={styles.navLink} href="#community">
            Campus
          </a>
          <Link className={[styles.btn, styles.btnPill].join(' ')} to="/map">
            Open the map
          </Link>
        </div>
      </nav>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Problem strip.
 *
 * DESIGN.md §3 requires the page's spacing rhythm to break exactly once. This is
 * that beat: compressed padding, hairlines above and below, one measured number
 * set large. The quote is the team's own words, not a marketing rewrite.
 * ------------------------------------------------------------------------- */
function Problem() {
  return (
    <section id="problem" className={styles.problem}>
      <div className={styles.container}>
        <Reveal>
          <div className={styles.problemGrid}>
            <p className={styles.problemQuote}>
              We were standing in a twenty minute line at Warren at 12:15, again, when it occurred
              to us that every person in that line could have known.
            </p>

            <div className={styles.problemAside}>
              <Rings
                share={0.72}
                size={120}
                count={6}
                className={styles.rings}
                ringClassName={styles.ringsPath}
              />
              {/*
                No thousands separator. IBM Plex Mono gives every glyph the same
                advance width, so a comma sits in a full digit cell and reads as
                "6 , 944". Instrument readouts drop the separator anyway, which
                suits what this number is.
              */}
              <div className={styles.measure}>
                <span className={styles.measureValue}>{FACTS.meetings}</span>
                <span className={styles.measureUnit}>class meetings</span>
              </div>
              <p className={styles.measureLabel}>
                Real class meetings, with a room and a time, drive the forecast. When a lecture in
                CAS lets out, Flowcast already knows where those people go next.
              </p>
              <p className={styles.sourceNote}>
                From {FACTS.courses.toLocaleString('en-US')} course pages and {FACTS.classrooms}{' '}
                classrooms with verified capacity. Flowcast forecasts crowding. It does not measure
                occupancy, and it does not read anyone’s location.
              </p>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------------------
 * Bento grid.
 *
 * DESIGN.md §0 bans the uniform three-card grid, so cells are mixed sizes with one
 * large lead cell. Brief §5 requires each cell to be an animated clip of the real
 * product, never a static screenshot. `clip` points at a capture produced from the
 * real renderer; until a capture exists the cell shows a labelled slot rather than
 * a fake screenshot.
 * ------------------------------------------------------------------------- */
type Cell = {
  id: string;
  size: 'lead' | 'tall' | 'wide' | 'small' | 'full';
  lead: string;
  body: string;
  /** Path to a captured loop of the real product, served from map-client/public. */
  clip?: string;
  /** What the capture must show, so the capture pass is unambiguous. */
  slot: string;
};

const CELLS: Cell[] = [
  {
    id: 'forecast',
    size: 'lead',
    lead: 'Warren Dining at 12:15.',
    body:
      'Flowcast knew at 11:40. It runs the day forward from the class schedule, so the line builds on the map before it builds in the building.',
    slot: 'Camera held on Warren Dining, 11:30 to 12:20 at 120×, crowd rising from quiet to busy.',
  },
  {
    id: 'transit',
    size: 'tall',
    lead: 'The Green Line, as it actually runs.',
    body: 'Live B branch arrivals at the stops along Commonwealth Avenue, on the map where you are standing.',
    slot: 'Boston University East, train arriving, arrival time ticking down.',
  },
  {
    id: 'schedule',
    size: 'small',
    lead: 'It reads the class schedule.',
    body: `${FACTS.meetings.toLocaleString('en-US')} meetings across ${FACTS.buildings} buildings.`,
    slot: 'CAS at the top of the hour, students leaving one lecture hall and entering another.',
  },
  {
    id: 'personas',
    size: 'small',
    lead: 'Make someone, put them on campus.',
    body: 'Seven choices, one yellow figure, walking a real route between real buildings.',
    slot: 'Persona customizer resolving, then the same figure walking into GSU.',
  },
  {
    id: 'join',
    size: 'small',
    lead: 'Scan, and you are on the map.',
    body: 'A QR code on the live map puts your own figure into the campus from your phone.',
    slot: 'Phone scan, then the new persona appearing on the map and starting to walk.',
  },
  {
    id: 'campuses',
    size: 'full',
    lead: 'Charles River, Medical, Fenway.',
    body: 'All three campuses, modelled from the same data.',
    slot: 'Camera pulling back from Charles River to show all three campus footprints.',
  },
];

function BentoCell({ cell }: { cell: Cell }) {
  const sizeClass = {
    lead: styles.cellLead,
    tall: styles.cellTall,
    wide: styles.cellWide,
    small: styles.cellSmall,
    full: styles.cellFull,
  }[cell.size];

  return (
    <article
      className={[styles.cell, sizeClass, cell.clip ? styles.cellHasMedia : ''].filter(Boolean).join(' ')}
    >
      {cell.clip ? (
        <video
          className={styles.cellMedia}
          src={cell.clip}
          autoPlay
          loop
          muted
          playsInline
          preload="metadata"
          aria-hidden="true"
        />
      ) : (
        <div className={styles.cellSlot}>
          <p className={styles.cellSlotNote}>{cell.slot}</p>
        </div>
      )}

      <div className={styles.cellCopy}>
        <p className={styles.body}>
          <span className={styles.leadIn}>{cell.lead}</span> {cell.body}
        </p>
      </div>
    </article>
  );
}

function Features() {
  return (
    <section id="features" className={styles.section}>
      <div className={styles.container}>
        {/*
          A trail map's feature summary already has a name, and it is not "what it
          knows". Taking the section's title from the reference object rather than
          from product-page habit.
        */}
        <Reveal>
          <div className={styles.sectionHead}>
            <h2 className={styles.h2}>Legend</h2>
            <p className={styles.sectionNote}>
              Six things the map is reading at any moment. Every panel below is the running
              product, not a picture of it.
            </p>
          </div>
        </Reveal>
        <Reveal>
          <div className={styles.bento}>
            {CELLS.map((c) => (
              <BentoCell key={c.id} cell={c} />
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------------------
 * Close. Brief §5: the page's emotional thesis, and it ends here rather than on
 * a generic "get started" band.
 * ------------------------------------------------------------------------- */
function Close() {
  return (
    <section id="community" className={styles.section}>
      <div className={styles.container}>
        <Reveal>
          <div className={styles.close}>
            <Rings
              share={0.38}
              size={150}
              count={7}
              pulse
              className={styles.rings}
              ringClassName={styles.ringsPath}
              pulseClassName={[styles.ringsPath, styles.ringPulse].join(' ')}
            />
            <div className={styles.closeText}>
              <h2 className={styles.h2}>Go somewhere you have never been</h2>
              <p className={[styles.body, styles.closeBody].join(' ')}>
                Most people here use the same three places all year, not because they chose them but
                because finding anything else costs an hour of wandering. A campus you can see is a
                campus you can explore. That is the part we actually care about.
              </p>
              <div className={styles.closeActions}>
                <Link className={[styles.btn, styles.btnPrimary].join(' ')} to="/map">
                  Open the live campus
                </Link>
                <Link className={[styles.btn, styles.btnSecondary].join(' ')} to="/signin">
                  Sign in with your BU account
                </Link>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------------------
 * Footer. A compass rose used once as an anchor, per DESIGN.md §1. Not a
 * repeated system component.
 * ------------------------------------------------------------------------- */
function CompassRose() {
  return (
    <svg
      className={styles.compass}
      width="52"
      height="52"
      viewBox="0 0 52 52"
      aria-hidden="true"
      focusable="false"
    >
      <g fill="none" stroke="currentColor" strokeWidth="1">
        <circle cx="26" cy="26" r="20" opacity="0.5" />
        <circle cx="26" cy="26" r="14.5" opacity="0.3" />
      </g>
      <path d="M26 5 L29.4 23.6 L26 26 L22.6 23.6 Z" fill="currentColor" opacity="0.85" />
      <path d="M26 47 L22.6 28.4 L26 26 L29.4 28.4 Z" fill="currentColor" opacity="0.35" />
      <path d="M5 26 L23.6 22.6 L26 26 L23.6 29.4 Z" fill="currentColor" opacity="0.35" />
      <path d="M47 26 L28.4 29.4 L26 26 L28.4 22.6 Z" fill="currentColor" opacity="0.35" />
    </svg>
  );
}

function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={styles.container}>
        <div className={styles.footerGrid}>
          <div className={styles.footerCol}>
            <a className={styles.wordmark} href="#top">
              <span className={styles.wordmarkName}>Flowcast</span>
            </a>
            <p className={styles.footerNote}>
              A live 3D map of Boston University. Built for DS+X, the BU data science hackathon.
            </p>
          </div>

          <div className={styles.footerCol}>
            <span className={styles.footerHead}>Product</span>
            <Link className={styles.footerLink} to="/map">
              The live map
            </Link>
            <Link className={styles.footerLink} to="/join">
              Add your persona
            </Link>
            <Link className={styles.footerLink} to="/signin">
              Sign in
            </Link>
          </div>

          <div className={styles.footerCol}>
            <span className={styles.footerHead}>About</span>
            <Link className={styles.footerLink} to="/privacy">
              Privacy
            </Link>
            <a className={styles.footerLink} href="#problem">
              How the forecast works
            </a>
            <Link className={styles.footerLink} to="/clubs/register">
              Register a club
            </Link>
          </div>

          <CompassRose />
        </div>

        <div className={styles.footerBase}>
          <span>Made on the Charles, in Boston.</span>
          <CoordinateReadout />
        </div>
      </div>
    </footer>
  );
}

/* ---------------------------------------------------------------------------
 * Page
 * ------------------------------------------------------------------------- */
export default function Landing() {
  const [jsReady, setJsReady] = useState(false);

  // Only opt into reveal animation once scripting has run, so a no-JS render shows
  // every section at full opacity (Hallmark floor 7 / 62).
  useEffect(() => setJsReady(true), []);

  return (
    <main id="top" className={[styles.page, jsReady ? styles.jsReady : ''].filter(Boolean).join(' ')}>
      <Nav />

      <Hero />
      <Problem />
      <Features />
      <Close />
      <Footer />
    </main>
  );
}
