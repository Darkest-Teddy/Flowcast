/*
 * The hero. LANDING_PAGE_BRIEF.md §3, built as the hybrid that was picked: a short
 * auto-dive on load that lands on the live campus, after which the page scrolls
 * normally. No scroll hijack on the first screen.
 *
 * The dive is not a video and not a faked sequence. Stages 2 and 3 are the real
 * camera: the renderer starts top-down over the whole campus, the clouds part to
 * reveal it, and then the actual basemap flies down to a low cinematic angle on
 * Warren Dining. The thing you break through the clouds into is the product.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { Basemap } from '@map/map/basemap';
import type { Persona, PersonaAgent } from '@map/sim/persona';
import { DEFAULT_APPEARANCE } from '@map/sim/personaParts';
import { HeroCampus } from './HeroCampus';
import { Rings } from './Rings';
import styles from './Hero.module.css';
import page from '../Landing.module.css';

/* ---------------------------------------------------------------------------
 * The cast.
 *
 * Brief §4: every persona on this page is the real customizable persona system,
 * in a specific named BU location, doing a specific named thing. No invented
 * illustrated characters. Each homeLocationId below is a real location id from
 * map-client's own campus data, so personaAgentAt() places them for real; an id
 * that did not exist would simply return null and the figure would not appear.
 *
 * Appearance ids are from the catalog in map-client/src/sim/personaParts.ts.
 * The body colour is not a choice: it is locked to BASE_BODY_COLOR, the
 * Pegman yellow.
 * ------------------------------------------------------------------------- */
const CAST: Persona[] = [
  {
    id: 'landing-warren-line',
    name: 'Waiting at Warren Dining',
    bio: '',
    homeLocationId: 'warren-dining',
    appearance: { ...DEFAULT_APPEARANCE, top: 'top-hoodie', bottom: 'bottom-jeans', backpack: 'backpack-daypack' },
    createdAt: '2026-10-24T12:15:00.000Z',
  },
  {
    id: 'landing-warren-line-2',
    name: 'Also waiting at Warren Dining',
    bio: '',
    homeLocationId: 'warren-dining',
    appearance: { ...DEFAULT_APPEARANCE, hair: 'hair-long', top: 'top-tank', bottom: 'bottom-skirt' },
    createdAt: '2026-10-24T12:15:00.000Z',
  },
  {
    id: 'landing-warren-line-3',
    name: 'Third in the line at Warren Dining',
    bio: '',
    homeLocationId: 'warren-dining',
    appearance: { ...DEFAULT_APPEARANCE, hair: 'hair-cap', top: 'top-jersey', shoes: 'shoes-sneakers' },
    createdAt: '2026-10-24T12:15:00.000Z',
  },
  {
    id: 'landing-gsu',
    name: 'On the plaza at GSU',
    bio: '',
    homeLocationId: 'gsu',
    appearance: { ...DEFAULT_APPEARANCE, face: 'face-sunglasses', backpack: 'backpack-hiking' },
    createdAt: '2026-10-24T12:15:00.000Z',
  },
  {
    id: 'landing-mugar',
    name: 'Studying at Mugar Memorial Library',
    bio: '',
    homeLocationId: 'mugar',
    appearance: { ...DEFAULT_APPEARANCE, face: 'face-glasses', top: 'top-hoodie', shoes: 'shoes-boots' },
    createdAt: '2026-10-24T12:15:00.000Z',
  },
];

/*
 * Where each figure actually stands, in metres east and north of its location's
 * point. A location's position is the building's centroid, so an un-nudged
 * persona stands inside the building and the model hides it. These offsets put
 * them on the pavement at the entrance, which is also where the brief wants
 * them: in a line outside the dining hall, not buried in the tower.
 *
 * Offsets only. The figure, its walk, and its location are all the real system.
 */
const STANDING: Record<string, { east: number; north: number }> = {
  // North of the dining point, onto the Commonwealth Avenue pavement. South put
  // them under the Warren Towers podium, where the roof hid them from any low
  // angle, and Comm Ave is where the line actually forms anyway.
  'landing-warren-line': { east: 6, north: 38 },
  'landing-warren-line-2': { east: 13, north: 40 },
  'landing-warren-line-3': { east: 20, north: 42 },
  'landing-gsu': { east: 10, north: 34 },
  'landing-mugar': { east: -8, north: 30 },
};

const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = 111_320 * Math.cos((42.35 * Math.PI) / 180);

/** Applies the standing offset to an agent produced by the real persona system. */
function placed(agent: PersonaAgent): PersonaAgent {
  const o = STANDING[agent.persona.id];
  if (!o) return agent;
  const [lng, lat, z] = agent.position;
  return {
    ...agent,
    position: [lng + o.east / M_PER_DEG_LON, lat + o.north / M_PER_DEG_LAT, z ?? 0],
  };
}

/* Camera stages. Coordinates are the real hand-modelled building centres. */
const WHOLE_CAMPUS = { center: [-71.1062, 42.3505] as [number, number], zoom: 13.4, pitch: 0, bearing: 0 };
/*
 * The landing shot. Close and low enough that a 1.5 m figure actually reads: at
 * zoom 16.9 the cast was a few pixels tall and lost against the roofs. Centred
 * east of the dining hall point so the line outside it sits right of the copy,
 * clear of the headline.
 */
const WARREN_DINING = { center: [-71.10388, 42.34983] as [number, number], zoom: 18.7, pitch: 46, bearing: 184 };

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function Hero() {
  const [phase, setPhase] = useState<'overture' | 'diving' | 'landed'>('overture');
  const [reduced, setReduced] = useState(false);
  const basemapRef = useRef<Basemap | null>(null);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    setReduced(prefersReducedMotion());
  }, []);

  useEffect(() => () => timers.current.forEach(window.clearTimeout), []);

  /*
   * The camera arrives when the renderer does, which may be before or after the
   * clouds start parting. So the dive is driven from here rather than from a
   * single fixed timeline: whenever the map is ready, it is placed top-down at
   * once and the descent is scheduled.
   */
  const onReady = useCallback((basemap: Basemap) => {
    basemapRef.current = basemap;

    if (prefersReducedMotion()) {
      basemap.jumpTo({ ...WARREN_DINING, pitch: Math.min(WARREN_DINING.pitch, basemap.maxPitch) });
      setPhase('landed');
      return;
    }

    // Stage 2: the whole campus, top-down, already behind the clouds.
    basemap.jumpTo(WHOLE_CAMPUS);
    setPhase('diving');

    // Stage 3: the commit. `fly` takes flyTo's arc, which is the parabola the
    // GTA-V switch uses rather than a straight interpolation.
    timers.current.push(
      window.setTimeout(() => {
        basemap.easeTo({
          ...WARREN_DINING,
          pitch: Math.min(WARREN_DINING.pitch, basemap.maxPitch),
          duration: 2400,
          fly: true,
          easing: (t) => 1 - Math.pow(1 - t, 4), // ease-out-quart: decelerates like a real descent
        });
      }, 760),
    );

    timers.current.push(window.setTimeout(() => setPhase('landed'), 3400));
  }, []);

  const scrollOn = useCallback(() => {
    document.getElementById('problem')?.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'start',
    });
  }, []);

  const phaseClass =
    phase === 'diving' ? styles.diving : phase === 'landed' ? styles.landed : undefined;

  return (
    <section
      className={[styles.hero, phaseClass, reduced ? styles.noMotion : ''].filter(Boolean).join(' ')}
      aria-label="Flowcast, a live 3D map of Boston University"
    >
      <div className={styles.stage}>
        <HeroCampus cast={CAST} onReady={onReady} place={placed} />
      </div>

      {/* Stage 1: the viewport is cloud, the wordmark sits quiet in it. */}
      <div className={styles.clouds} aria-hidden="true">
        <div className={[styles.cloud, styles.cloudFar].join(' ')} />
        <div className={[styles.cloud, styles.cloudMid].join(' ')} />
        <div className={[styles.cloud, styles.cloudNear].join(' ')} />
      </div>
      <div className={styles.overture} aria-hidden="true">
        <span className={styles.overtureMark}>Flowcast</span>
      </div>

      <div className={page.container}>
        <div className={styles.copy}>
          <h1 className={[page.h1, styles.title].join(' ')}>See the line before you’re in it.</h1>
          {/* Adds the mechanism rather than restating the headline above it. */}
          <p className={styles.sentence}>
            Simulated students, on real class schedules, walking a real campus. So you can see 12:15
            coming at 11:40.
          </p>
          <div className={styles.actions}>
            <Link className={[page.btn, page.btnPrimary].join(' ')} to="/map">
              Open the live campus
            </Link>
            {/* DESIGN.md §6: a surveyor's coordinate and the wall clock carry
                "this is live", never a coloured-dot badge. */}
            <span className={styles.stamp}>
              <LiveStamp />
            </span>
          </div>
        </div>
      </div>

      <button type="button" className={styles.cue} onClick={scrollOn}>
        <span className={styles.cueMark} aria-hidden="true">
          <Rings
            share={0.3}
            size={44}
            count={3}
            pulse
            className={styles.cueRing}
            ringClassName={page.ringsPath}
            pulseClassName={[page.ringsPath, page.ringPulse].join(' ')}
          />
        </span>
        Scroll to see how it works
      </button>
    </section>
  );
}

function LiveStamp() {
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

  if (!stamp) return null;
  return <span className={page.data}>{stamp}</span>;
}
