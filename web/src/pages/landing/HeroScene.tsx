/*
 * The live 3D campus behind the title screen.
 *
 * This is the real map-client renderer, not a picture of it and not the stylised CSS
 * boxes it replaces: real building models, the Green Line and MBTA buses running on
 * a real motion model, and students walking real routes.
 *
 * It is NOT the map application. Importing `@map/main` would mount the whole app at
 * `#root`, and `@map/styles.css` sets `overflow: hidden` on html and body, which
 * would kill the landing page's scroll. Everything here is composed from the
 * individual exports instead.
 *
 * Three constraints shaped the implementation:
 *
 *   1. Weight. The full scene is ~41 MB. The title screen covers the load, and the
 *      scene arrives in stages: buildings and transit first (they carry the shot),
 *      walkers afterwards. If the walker file never lands, the hero still works.
 *   2. createBasemap has no timeout. On the tokenless path it waits on OpenFreeMap,
 *      a third-party host, forever. It is raced here, and failure is survivable.
 *   3. Draw calls, not shaders, are this renderer's budget. Four character models
 *      rather than twelve means 12 walker layers rather than 36.
 */

import { useEffect, useRef, useState } from 'react';
import type { Basemap, CameraState } from '@map/map/basemap';
import type { WalkingAgent } from '@map/sim/playback';
import styles from './HeroScene.module.css';
import type { DepthState } from './useDepth';

export interface HeroSceneHandle {
  /** Pointer and scroll depth, applied to the real camera. */
  applyDepth(state: DepthState): void;
  /** Fly in, for when the visitor commits from the title screen. */
  commit(): void;
  /** The live canvas, for recording the title-screen background from it. */
  canvas(): HTMLCanvasElement | null;
}

/*
 * Capture mode, entered with ?capture=1.
 *
 * Holds the camera perfectly still and slows the simulation. Still, because the
 * recording is the title screen's background and the live scene starts from the
 * same camera: if every recorded frame shares that exact camera, the handoff from
 * video to canvas has nothing to mismatch.
 *
 * Slow, because this is the only way to get smooth footage off a machine that
 * cannot render quickly. Recording at a third speed and playing the file back at
 * three times gives correct-looking motion at three times the frame rate, because
 * the frames are real -- they were just gathered over a longer wall clock.
 */
const CAPTURE_SIM_SCALE = 1 / 3;
export const CAPTURE_PLAYBACK_RATE = 3;

interface Props {
  onReady?: (handle: HeroSceneHandle) => void;
  /**
   * Sim time to open on, in seconds since Boston midnight. 20:00: dark enough for
   * the lit windows and the Citgo sign, late enough that the Green Line and the 57
   * are still running and there are people on Comm Ave.
   */
  openAt?: number;
}

/*
 * The shot. basemap.ts's own DEFAULT_VIEW comment describes this framing as the one
 * the scene was built for: "From behind Kenmore looking west up Comm Ave: the Citgo
 * sign's lit face up front, the whole campus strip along the Charles behind it."
 *
 * Tightened from that default so the Green Line rails draw (they need zoom >= 16)
 * and walkers still read. Must stay inside BOSTON_LIMITS: [[-71.135, 42.325],
 * [-71.045, 42.368]] at zoom >= 13.5.
 */
/*
 * Straight down, north up: the campus strip along the Charles, Fenway at one end,
 * Kenmore in the middle. This is the title screen's backdrop, and it reads as a map
 * rather than as a scene, which is what makes the tilt into 3D feel like an arrival.
 *
 * Must stay inside BOSTON_LIMITS: [[-71.135, 42.325], [-71.045, 42.368]], zoom >= 13.5.
 */
const OPENING: CameraState = { center: [-71.1055, 42.3505], zoom: 14.6, pitch: 0, bearing: 0 };

/* Where the flight lands: low over Comm Ave, looking west past Kenmore and the
   Citgo sign, with the Green Line median running away up-screen. */
const COMMITTED: CameraState = { center: [-71.1035, 42.3494], zoom: 16.3, pitch: 62, bearing: 252 };

/* Long enough to read as a camera move rather than a cut. */
const FLIGHT_MS = 4200;

/** How far the pointer is allowed to move the real camera. Small on purpose. */
const DEPTH_BEARING = 3.2;
const DEPTH_PITCH = 2.0;

/*
 * Pixel ratio for the hero's canvas.
 *
 * This is the one real lever on GPU fill cost. The map repaints every frame
 * (interleaved deck.gl with _animate), so the canvas is redrawn continuously and
 * its pixel count dominates. Only the 3D scene is affected -- all type and UI are
 * DOM and stay crisp -- so 1.0 is a good trade for a background element.
 */
const HERO_DPR = 1;

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Rejects rather than hanging. createBasemap awaits a third-party tile host with no timeout. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)),
  ]);
}

/** Recorded from this renderer by captureTitleVideo, served from map-client/public. */
const TITLE_VIDEO = '/video/title-campus.webm';

export function HeroScene({ onReady, openAt = 20 * 3600 }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const [handedOver, setHandedOver] = useState(false);
  const capture = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('capture') === '1';

  // Played faster than it was recorded, which is what makes it smooth.
  useEffect(() => {
    const v = videoRef.current;
    if (v) v.playbackRate = CAPTURE_PLAYBACK_RATE;
  }, []);

  useEffect(() => {
    const host = wrap.current;
    if (!host) return;

    let cancelled = false;
    let frame = 0;
    let basemap: Basemap | null = null;
    let restoreDpr: (() => void) | null = null;

    // A fresh child per mount: StrictMode mounts twice in dev and the first map is
    // still tearing down when the second is created.
    const el = document.createElement('div');
    el.className = styles.canvas;
    host.appendChild(el);

    (async () => {
      try {
        /*
         * Cap the device pixel ratio BEFORE importing anything from map-client.
         * perf/quality.ts permanently redefines window.devicePixelRatio at import
         * time, capturing whatever it reads then as "native". Capping first means
         * the hero renders at 1.5x on a 2x/3x display, which is most of the GPU
         * fill cost for almost no visible difference at this size.
         */
        const nativeDpr = window.devicePixelRatio;
        if (nativeDpr > HERO_DPR) {
          Object.defineProperty(window, 'devicePixelRatio', {
            configurable: true,
            get: () => HERO_DPR,
          });
          restoreDpr = () => {
            Object.defineProperty(window, 'devicePixelRatio', {
              configurable: true,
              get: () => nativeDpr,
            });
          };
        }

        // Everything below is dynamically imported so deck.gl, mapbox-gl,
        // maplibre-gl and loaders.gl stay out of the landing page's main chunk.
        const [
          { createBasemap },
          // deck.gl and loaders.gl are installed in map-client, not here; it
          // re-exports them so the package export maps still resolve.
          { MapboxOverlay, load, GLTFLoader },
          { cullLayers },
          { loadBuildingManifest, loadBuildingModels, buildingModelLayers },
          { loadTransit, MbtaFeed },
          { ScheduledTransit },
          { transitLayers, loadVehicleModels },
          { loadMonuments, monumentLayers },
          { CHARACTER_MODELS, characterLayers },
          { mergeSkinnedMeshes },
        ] = await Promise.all([
          import('@map/map/basemap'),
          import('@map/renderDeps'),
          import('@map/layers/culling'),
          import('@map/layers/buildings'),
          import('@map/transit/mbta'),
          import('@map/transit/scheduled'),
          import('@map/layers/transit'),
          import('@map/layers/monuments'),
          import('@map/layers/agents'),
          import('@map/layers/gltf-merge'),
        ]);

        if (cancelled) return;

        /*
         * The lit-window meshes are kept. They are 3.6 MB, but at night they are the
         * single best-looking thing in this renderer, and they cost nothing per
         * frame: each window carries its own on/off times and a clock uniform
         * switches them in the shader.
         */
        const manifest = await loadBuildingManifest();
        if (cancelled) return;

        const [bm, buildings, transitData, vehicleModels, monuments, charModels] = await Promise.all([
          withTimeout(
            createBasemap(el, 'night', {
              /*
               * The dark style. Without a Mapbox token `setLightPreset` is a no-op,
               * so swapping the MapLibre style is the only way to get a night look
               * on this path. It is also cheaper: 47 style layers against Liberty's
               * 111.
               */
              styleUrl: 'https://tiles.openfreemap.org/styles/dark',
            }),
            12_000,
            'basemap',
          ),
          loadBuildingModels(manifest, ['charles-river']),
          loadTransit('/data/transit.json'),
          loadVehicleModels().catch(() => ({})),
          loadMonuments().catch(() => null),
          // Four of the twelve. characterLayers buckets on `model % models.length`,
          // so a short list is fully supported, and 4 x 3 phases = 12 layers.
          Promise.all(
            [0, 3, 6, 9].map((i) => load(CHARACTER_MODELS[i], GLTFLoader).then(mergeSkinnedMeshes)),
          ),
        ]);

        if (cancelled) {
          bm.remove();
          return;
        }
        basemap = bm;

        // The base map draws its own extrusions for buildings we model in detail;
        // without this they z-fight.
        const modelled = manifest.campuses.flatMap((c) => c.buildings.map((b) => b.osm));
        basemap.excludeBuildings(
          modelled.map((ref) => Number(String(ref).split('/')[1])).filter(Number.isFinite),
        );

        // INITIAL_VIEW is read from the page URL at import time, so a stray ?zoom=
        // on a marketing link would move the hero. Always set the camera explicitly.
        basemap.jumpTo(OPENING);

        /*
         * `_animate` is deliberately off until walkers exist.
         *
         * With it on, deck repaints the interleaved base map continuously, which is
         * what the map application does and why it is heavy. The hero does not need
         * that: vehicles move by position, not by an animation clock, so updating
         * layers on our own schedule is enough. It is switched on only if the walker
         * file lands, because walk cycles genuinely do need a running clock.
         */
        const overlay = new MapboxOverlay({
          interleaved: true, // so buildings occlude people correctly
          _animate: false,
          layerFilter: cullLayers, // the only frustum culling in the stack
        });
        basemap.addControl(overlay);

        /*
         * Synthetic headways rather than the 4.3 MB published timetable. Still a real
         * motion model: acceleration, braking, dwell at stops, red signals. The
         * tracks come from MbtaFeed's constructor; its network polling is never
         * started, so nothing here touches the MBTA API.
         */
        const feed = new MbtaFeed(transitData, () => {});
        const source = new ScheduledTransit(transitData, feed.tracks);

        // Walkers are deferred: ~21 MB, and the shot works without them.
        let playback: { walkingAt(t: number): WalkingAgent[] } | null = null;
        void (async () => {
          try {
            const { loadDay, Playback } = await import('@map/sim/playback');
            const day = await loadDay('/data/demo-day.json');
            if (!cancelled) {
              playback = new Playback(day);
              overlay.setProps({ _animate: true }); // walk cycles need a running clock
            }
          } catch {
            // No walkers. Buildings and transit still carry the scene.
          }
        })();

        const capturing = new URLSearchParams(window.location.search).get('capture') === '1';
        const reduced = prefersReducedMotion();
        let simTime = openAt;
        let last = performance.now();
        let drift = 0;
        const depth = { x: 0, y: 0, scroll: 0 };
        let target: CameraState = OPENING;
        // The last camera actually pushed, so sub-perceptible moves can be skipped.
        const applied = { bearing: OPENING.bearing, pitch: OPENING.pitch };

        /*
         * Swap the recording for the live canvas. Once over, the degradation guard
         * is irrelevant -- a visitor who committed wants the real thing moving, even
         * if it is slow -- so the loop is allowed to keep running from here.
         */
        let over = false;
        const handOver = () => {
          if (over) return;
          over = true;
          el.classList.add(styles.canvasLive);
          setHandedOver(true);
          // Stop decoding a video nobody can see.
          window.setTimeout(() => videoRef.current?.pause(), 700);
          // Start animating only now. Until this point the scene was drawn once and
          // left alone: repainting a canvas nobody can see would cost exactly as
          // much as showing it, and the recording is on screen instead.
          last = performance.now();
          frame = requestAnimationFrame(tick);
        };

        const handle: HeroSceneHandle = {
          applyDepth(state) {
            depth.x = state.x;
            depth.y = state.y;
            depth.scroll = state.scroll;
          },
          canvas() {
            return el.querySelector('canvas');
          },
          commit() {
            /*
             * Hand over before flying, not during.
             *
             * The recording and the live canvas show the same camera, so the
             * cross-fade has nothing to mismatch; then the flight begins from a
             * scene that is already on screen and already drawn. Starting the
             * flight first would mean fading between two different cameras.
             */
            handOver();

            target = COMMITTED;
            applied.bearing = COMMITTED.bearing;
            applied.pitch = COMMITTED.pitch;
            /*
             * A direct interpolation, not flyTo's arc. flyTo pulls back before
             * diving, which is right when crossing a city; here the camera is
             * already high and straight down, so arcing would read as a lurch.
             * easeInOutCubic keeps the start and the landing both unhurried.
             */
            basemap?.easeTo({
              ...COMMITTED,
              duration: reduced ? 0 : FLIGHT_MS,
              fly: false,
              easing: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
            });
          },
        };
        /*
         * Layers are rebuilt at ~20fps, not 60. Each setProps repaints the whole
         * interleaved base map, and at this scene's speed (a bus crossing a few
         * metres a second) three times that rate buys nothing visible.
         */
        const LAYER_INTERVAL_MS = 50;
        let sinceLayers = LAYER_INTERVAL_MS;

        /*
         * Graceful degradation.
         *
         * On a weak GPU a single frame of this scene can cost most of a second, and
         * no update-rate throttle helps with that. Rather than serve a hero that
         * stutters, measure real frame cost over the first couple of seconds and, if
         * it is hopeless, stop animating and leave the campus standing still. A still
         * 3D Boston is a good backdrop; a 1fps one is a broken-looking page.
         */
        const PROBE_FRAMES = 24;
        const TOO_SLOW_MS = 120; // under ~8fps
        const probe: number[] = [];
        let degraded = false;

        const tick = (now: number) => {
          if (cancelled || !basemap) return;
          const raw = now - last;
          const elapsed = Math.min(100, raw);
          last = now;
          sinceLayers += elapsed;

          if (!degraded && probe.length < PROBE_FRAMES) {
            // Skip the first few frames: they include shader compilation and upload.
            if (probe.length > 0 || raw < 2000) probe.push(raw);
            if (probe.length === PROBE_FRAMES) {
              const median = [...probe].sort((a, b) => a - b)[PROBE_FRAMES >> 1];
              if (median > TOO_SLOW_MS) {
                degraded = true;
                console.info(
                  `[Flowcast hero] ${Math.round(median)}ms frames on this GPU; holding the campus still.`,
                );
              }
            }
          }

          // Clock runs at 4x so the Green Line and buses visibly move.
          const rate = capturing ? 4 * CAPTURE_SIM_SCALE : 4;
          simTime = (simTime + (elapsed * rate) / 1000) % 86400;
          source.setTime(simTime);

          /*
           * Depth on the real camera. This is what makes the parallax true rather
           * than a CSS approximation: moving the camera means near buildings sweep
           * further than far ones and occlusion stays correct, for free.
           *
           * Skipped entirely while an easeTo is running, so the commit flight is
           * never fought by the pointer.
           */
          // Capture holds the camera exactly still, so every recorded frame shares
          // the live scene's opening camera and the handoff cannot mismatch.
          if (!capturing && !reduced && !degraded && !basemap.isEasing() && depth.scroll < 1) {
            drift += elapsed;
            const breathe = Math.sin(drift / 9000) * 0.9;
            const bearing = target.bearing + depth.x * DEPTH_BEARING + breathe;
            const pitch = Math.min(
              basemap.maxPitch,
              Math.max(25, target.pitch + depth.y * DEPTH_PITCH),
            );
            /*
             * Only move when it would actually be visible. Every jumpTo forces the
             * base map to re-render its whole style, so calling it on each frame for
             * a hundredth of a degree was costing most of the frame budget. Below
             * these thresholds the move is imperceptible and simply not worth a
             * repaint.
             */
            if (Math.abs(bearing - applied.bearing) > 0.05 || Math.abs(pitch - applied.pitch) > 0.05) {
              applied.bearing = bearing;
              applied.pitch = pitch;
              basemap.jumpTo({ center: target.center, zoom: target.zoom, bearing, pitch });
            }
          }

          /*
           * Degrading belongs to the idle title screen only.
           *
           * The loop does not even start until someone commits, and by then they are
           * watching the campus. Stopping here would freeze the canvas mid-flight on
           * a stale frame: the camera keeps moving while the pixels do not, because
           * an interleaved deck overlay only repaints when setProps is called. A
           * slow flight is bad; a frozen one looks broken.
           */
          if (degraded && !capturing && !over) {
            drawLayers(now);
            overlay.setProps({ _animate: false });
            return;
          }

          if (sinceLayers < LAYER_INTERVAL_MS) {
            frame = requestAnimationFrame(tick);
            return;
          }
          sinceLayers = 0;
          drawLayers(now);

          frame = requestAnimationFrame(tick);
        };

        function drawLayers(now: number) {
          if (!basemap) return;
          const zoom = basemap.getZoom();
          const walkers = playback ? pick(playback.walkingAt(simTime), 70) : [];

          overlay.setProps({
            layers: [
              ...buildingModelLayers(manifest, buildings, {
                campuses: ['charles-river'],
                clock: simTime,
                // Pinned to night rather than following the sun at `clock`: the
                // basemap is the dark style, and an auto tint would drift away
                // from it as the sim clock runs.
                lightPreset: 'night',
                auto: false,
                litWindows: true,
              }),
              ...transitLayers({
                data: transitData,
                feed: source,
                now,
                zoom,
                models: vehicleModels,
                time: simTime,
                weekday: 3,
              }),
              // 'night' also switches the Citgo sign on: it lights when the clock is
              // between noon and midnight and either the sun is down or the preset
              // is night.
              ...(monuments ? monumentLayers(monuments, { zoom, lightPreset: 'night', time: simTime }) : []),
              // Never agentLayers: it hardcodes id 'agents', which collides with the
              // map app's ids in the shared culling and stable-list caches.
              ...characterLayers(walkers, charModels, simTime, {
                id: 'hero-walk',
                zoom,
                clip: 'walk',
                pickable: false,
              }),
            ],
          });
        }

        /*
         * Draw the whole scene once, and only then report ready.
         *
         * "Ready" has to mean painted, not started. Everything the flight will pass
         * over -- buildings, the Citgo sign, trains, buses -- is already uploaded and
         * on screen by this point, so clicking Explore does no loading at all: it is
         * a pure camera move over geometry that is already there.
         */
        drawLayers(performance.now());
        // In capture mode there is no video and the canvas is the thing being
        // recorded, so it has to be visible. Otherwise it stays hidden beneath the
        // recording until someone commits.
        if (capture) el.classList.add(styles.canvasLive);
        onReady?.(handle);

        if (import.meta.env.DEV) {
          (window as unknown as Record<string, unknown>).__flowcastHero = { handle, basemap, OPENING, COMMITTED };
        }

        /*
         * The scene is loaded and drawn, and that is all it needs to be until
         * someone commits. Not starting the loop here is the whole reason the title
         * screen stays cheap: the GPU sits idle behind a playing video, and the
         * flight begins from geometry that is already uploaded and already drawn.
         *
         * Capture mode is the exception -- there the canvas IS the output.
         */
        if (!capture) return;

        if (capturing && import.meta.env.DEV) {
          const { captureTitleVideo } = await import('./captureTitleVideo');
          (window as unknown as Record<string, unknown>).__captureTitleVideo = (seconds = 30) =>
            captureTitleVideo(handle.canvas()!, { seconds });
          console.info('[Flowcast capture] ready. Run: await __captureTitleVideo(30)');
        }
        frame = requestAnimationFrame(tick);
      } catch (err) {
        if (!cancelled) {
          console.error('[Flowcast hero] the campus scene could not start', err);
          setFailed(true);
        }
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      // Must run before the element is removed, or a WebGL context leaks per mount.
      basemap?.remove();
      el.remove();
      restoreDpr?.();
    };
    // Mounts once. openAt is read at start and is not meant to be reactive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={styles.stage} aria-hidden="true">
      <div ref={wrap} className={styles.parallax}>
        {/*
          The recorded backdrop. It paints immediately and costs only video decode,
          while the real renderer loads behind it. Played faster than recorded;
          see captureTitleVideo.ts for why.
        */}
        {!capture && (
          <video
            ref={videoRef}
            className={[styles.video, handedOver ? styles.videoSpent : ''].filter(Boolean).join(' ')}
            src={TITLE_VIDEO}
            autoPlay
            loop
            muted
            playsInline
            preload="auto"
          />
        )}
      </div>
      {failed && <p className={styles.fallback}>The live campus needs WebGL and a network connection.</p>}
    </div>
  );
}

/**
 * A stable subset, capped. The same people stay drawn frame to frame, so deck.gl's
 * stable-list cache keeps handing it the same array instead of re-uploading every
 * vertex attribute for every model each frame.
 */
function pick<T extends { id: string }>(all: T[], cap: number): T[] {
  if (all.length <= cap) return all;
  const keep = cap / all.length;
  return all.filter((w) => hash(w.id) < keep);
}

function hash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return (Math.abs(h) % 1000) / 1000;
}
