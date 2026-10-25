/*
 * HeroCampus — the real Flowcast renderer, mounted bare.
 *
 * LANDING_PAGE_BRIEF.md §3.3 requires the hero's 3D view to be the actual product,
 * not a video or a screenshot. This mounts map-client's own basemap and deck.gl
 * overlay directly, via the `@map/*` alias that web/vite.config.ts already resolves.
 *
 * It deliberately does NOT import `@map/main` or `@map/styles.css`. Those mount the
 * whole application: a hard-coded `#root`, a full HUD, and an unscoped
 * `html, body, #root, .app { height: 100%; overflow: hidden }` that would stop this
 * page scrolling. So the composition is rebuilt here from the exported pieces.
 *
 * It also omits `agentLayers`. That single call constructs 36 ScenegraphLayers for
 * 732 simulated walkers every frame; the hero needs a handful of personas, not the
 * crowd, and skipping it is the difference between ~103 layers and ~2.
 */

import { useEffect, useRef, useState } from 'react';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { createBasemap, type Basemap } from '@map/map/basemap';
import { loadBuildings, buildingModelLayers } from '@map/layers/buildings';
import { personaLayers } from '@map/layers/personas';
import { personaAgentAt, type Persona, type PersonaAgent } from '@map/sim/persona';
import { loadDay } from '@map/sim/playback';
import styles from './HeroCampus.module.css';

type Props = {
  /** The cast placed on campus. Each homeLocationId must be a real location id. */
  cast: Persona[];
  /** Handed the camera once the scene is live, so the page can fly it. */
  onReady?: (basemap: Basemap) => void;
  /**
   * Adjusts each agent after the real persona system produces it. Used to stand a
   * figure at a building's entrance rather than its centroid, where the building
   * model would hide it.
   */
  place?: (agent: PersonaAgent) => PersonaAgent;
};

export function HeroCampus({ cast, onReady, place }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const castRef = useRef(cast);
  const placeRef = useRef(place);
  const [ready, setReady] = useState(false);

  // Kept in refs so changing either never tears down the renderer.
  castRef.current = cast;
  placeRef.current = place;

  useEffect(() => {
    const host = wrap.current;
    if (!host) return;

    let cancelled = false;
    let frame = 0;
    let basemap: Basemap | null = null;

    // A fresh child per mount. In dev, StrictMode mounts twice and the first map is
    // still tearing down when the second is created.
    const el = document.createElement('div');
    el.className = styles.map;
    host.appendChild(el);

    (async () => {
      let day: Awaited<ReturnType<typeof loadDay>>;
      let buildings: Awaited<ReturnType<typeof loadBuildings>> | null = null;

      try {
        [basemap, day, buildings] = await Promise.all([
          createBasemap(el, 'dawn', {
            // Positron is near-monochrome: pale ground, grey extrusions, muted roads.
            // Full-colour OSM fails DESIGN.md's test outright, since none of those
            // greens and yellows would appear on a printed trail map. This gets the
            // structure right; the hero's linen vignette warms it the rest of the way.
            styleUrl: 'https://tiles.openfreemap.org/styles/positron',
            // No side panel here, so the campus is actually centred rather than
            // pushed left to clear one.
            padding: { top: 0, bottom: 0, left: 0, right: 0 },
          }),
          loadDay('/data/demo-day.json'),
          loadBuildings().catch(() => null),
        ]);
      } catch (err) {
        // A hero that cannot build its map stays empty; the headline and the call to
        // action above it still read and still work. But never swallow the reason --
        // a silent catch here hid a dead render loop for a long time.
        console.error('[Flowcast hero] the campus renderer failed to start', err);
        return;
      }

      if (cancelled || !basemap) {
        basemap?.remove();
        return;
      }

      // The hand-built campus GLBs replace the basemap's own extrusions for the
      // same footprints, so the two never z-fight.
      if (buildings) {
        const modelled = buildings.manifest.campuses.flatMap((c) => c.buildings.map((b) => b.osm));
        basemap.excludeBuildings(modelled.map((r) => Number(String(r).split('/')[1])).filter(Number.isFinite));
      }

      const overlay = new MapboxOverlay({ interleaved: false });
      basemap.addControl(overlay);

      onReady?.(basemap);

      const tick = () => {
        if (cancelled || !basemap) return;
        const t = performance.now() / 1000;

        // personaAgentAt is pure and keyed to wall-clock time, so a persona's walk
        // is identical on every device without a server.
        const agents = castRef.current
          .map((p) => personaAgentAt(p, day.locations, Date.now()))
          .filter((a): a is PersonaAgent => a !== null)
          .map((a) => (placeRef.current ? placeRef.current(a) : a));

        // Dev-only handle, matching map-client's own __flowcast convention, so the
        // hero's cast and camera can be inspected from the console.
        /*
         * personaLayers sizes figures through zoomGrowth(zoom), which returns 1 at
         * zoom 18.6 and above, i.e. true-to-life. At this framing a 1.5 m person is
         * about five pixels tall and simply is not legible.
         *
         * The product already draws people larger than life as the camera pulls
         * back; this reports a zoom a couple of steps wider than the camera's, so
         * the same mechanism keeps the cast readable at close range. Nothing else
         * about them changes: the geometry, the walk and the placement are real.
         */
        const PERSONA_ZOOM_LIFT = 1.6;
        const people = personaLayers(agents, {
          zoom: basemap.getZoom() - PERSONA_ZOOM_LIFT,
          time: t,
        });

        if (import.meta.env.DEV) {
          (window as unknown as Record<string, unknown>).__flowcastHero = {
            basemap,
            overlay,
            agents,
            personaLayerCount: people.length,
            personaLayerIds: people.map((l) => l.id),
            cast: castRef.current,
            locationIds: day.locations.map((l) => l.id),
          };
        }

        overlay.setProps({
          layers: [
            ...(buildings
              ? buildingModelLayers(buildings.manifest, buildings.models, {
                  lightPreset: 'dawn',
                  campuses: ['charles-river'],
                })
              : []),
            ...people,
          ],
        });

        frame = requestAnimationFrame(tick);
      };

      frame = requestAnimationFrame(tick);
      el.classList.add(styles.mapReady);
      setReady(true);
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      basemap?.remove();
      el.remove();
    };
    // Mount once. The cast is read through a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={wrap} className={styles.wrap} data-ready={ready || undefined} aria-hidden="true" />;
}
