import { useEffect, useRef, useState } from 'react';
import { MapboxOverlay } from '@deck.gl/mapbox';
import type { PickingInfo } from '@deck.gl/core';
import { createBasemap, INITIAL_VIEW, TRAFFIC_LEVELS, type Basemap, type LightPreset } from './map/basemap';
import { agentLayers, loadCharacterModels, type LoadedModels } from './layers/agents';
import { crowdLayers, crowdLevel } from './layers/crowd';
import { createPlacer } from './layers/placement';
import { buildingModelLayers, loadBuildings } from './layers/buildings';
import { loadVehicleModels, transitLayers, transitTooltip, type VehicleModels } from './layers/transit';
import { Playback, formatClock, loadDay, type Campus, type Occupancy, type WalkingAgent } from './sim/playback';
import { MbtaFeed, loadTransit, minutesUntil, type TransitData } from './transit/mbta';
import { loadShuttles } from './transit/buShuttle';
import { trackCorridors } from './transit/tracks';
import { CameraControls } from './CameraControls';

const SPEEDS = [1, 30, 120, 600];
const params = new URLSearchParams(window.location.search);
// Live by default: the simulated day follows the real clock at 1x, so walkers, trains and buses
// all move at their true relative speeds. ?at= or ?speed= start in playback mode instead.
const START_LIVE = !params.has('at') && !params.has('speed');

/** Seconds since local midnight, right now. */
function wallClockSeconds(): number {
  const d = new Date();
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000;
}

/** ?at=9:00 (24h clock) starts playback there; default is the run-up to the 9:05 class change. */
function startTimeFromUrl(): number {
  const at = params.get('at');
  const match = at?.match(/^(\d{1,2}):(\d{2})$/);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 : 8 * 3600 + 50 * 60;
}

const START_AT = START_LIVE ? wallClockSeconds() : startTimeFromUrl();
const START_SPEED = START_LIVE ? 1 : Number(params.get('speed')) || SPEEDS[1];
const OCCUPANCY_REFRESH_MS = 500;

interface Hud {
  time: number;
  walking: number;
  occupancy: Occupancy[];
}

interface Transit {
  data: TransitData;
  feed: MbtaFeed;
  models: VehicleModels;
}

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const basemapRef = useRef<Basemap | null>(null);
  const timeRef = useRef(START_AT);
  const speedRef = useRef(START_SPEED);
  const playingRef = useRef(true);
  const liveRef = useRef(START_LIVE);
  const selectedRef = useRef<string | null>(null);
  const transitRef = useRef<Transit | null>(null);
  const showTransitRef = useRef(true);

  const [status, setStatus] = useState('Loading campus…');
  const [mapKind, setMapKind] = useState<Basemap['kind'] | null>(null);
  const [hud, setHud] = useState<Hud | null>(null);
  const [range, setRange] = useState<[number, number]>([0, 86400]);
  const [speed, setSpeed] = useState(START_SPEED);
  const [live, setLive] = useState(START_LIVE);
  const [playing, setPlaying] = useState(true);
  const [light, setLight] = useState<LightPreset>('dusk');
  const lightRef = useRef<LightPreset>('dusk'); // read by the frame loop (building model tint)
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<'crowds' | 'transit'>('crowds');
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [campus, setCampus] = useState('charles-river');
  const [showTransit, setShowTransit] = useState(true);
  const [showTraffic, setShowTraffic] = useState(true);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [feedUpdatedAt, setFeedUpdatedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let frame = 0;
    let overlay: MapboxOverlay | null = null;

    // A fresh element per mount: in dev, StrictMode mounts twice, and the first map is still
    // being torn down when the second is created.
    const mapElement = document.createElement('div');
    mapElement.className = 'map';
    containerRef.current!.appendChild(mapElement);

    (async () => {
      const [basemap, day, models, transitData, vehicleModels, detailedBuildings] = await Promise.all([
        createBasemap(mapElement, light),
        loadDay('/data/demo-day.json'),
        loadCharacterModels() as Promise<LoadedModels>,
        // Transit is an extra: the campus view must still start if it can't load.
        loadTransit('/data/transit.json').catch(() => null),
        loadVehicleModels().catch(() => ({})),
        // Detailed BU building models; the map still works with Mapbox's plain boxes without them.
        loadBuildings().catch(() => null),
      ]);
      if (cancelled) return basemap.remove();
      basemapRef.current = basemap;
      setMapKind(basemap.kind);

      if (transitData) {
        // BU's own shuttles join the MBTA data: same tracks, snapping and panels.
        const shuttle = await loadShuttles(transitData.areas).catch(() => undefined);
        if (shuttle) {
          transitData.routes.push(...shuttle.routes);
          transitData.stops.push(...shuttle.stops);
        }
        const feed = new MbtaFeed(
          transitData,
          (state) => {
            setFeedError(state.error);
            setFeedUpdatedAt(state.updatedAt);
          },
          shuttle,
        );
        feed.start();
        transitRef.current = { data: transitData, feed, models: vehicleModels };
        // Keep the base map's trees off the Green Line trackbed.
        basemap.clipModels(trackCorridors(feed.tracks.filter((t) => t.route.startsWith('Green-')), 3.2));
      }

      const playback = new Playback(day);
      setRange([playback.startTime, playback.endTime]);
      setCampuses(day.campuses ?? []);

      overlay = new MapboxOverlay({
        interleaved: new URLSearchParams(window.location.search).get('interleaved') !== '0',
        _animate: true, // keeps the walk cycles ticking between data updates
        // Building footprints and labels both carry the building id; anything else clears.
        onClick: ({ object }: PickingInfo) => {
          const isBuilding = object && ('polygon' in object || 'share' in object);
          const id = isBuilding ? (object as { id: string }).id : null;
          selectedRef.current = id;
          setSelected(id);
        },
        getTooltip: ({ object }: PickingInfo) => {
          const transit = transitRef.current;
          const text = transit ? transitTooltip(object, transit.data, transit.feed) : null;
          if (text) return text;
          if (!object || !('bearing' in object) || 'receivedAt' in object) return null;
          const agent = object as WalkingAgent;
          return `Student ${agent.id} → ${playback.locations.find((l) => l.id === agent.to)?.name}`;
        },
      });
      basemap.addControl(overlay);
      // Dev-only handle for poking at layers from the browser console.
      if (import.meta.env.DEV) Object.assign(window, { __flowcast: { overlay, basemap, playback, transitRef } });
      setStatus('');

      let last = performance.now();
      let lastOccupancy = 0;
      let occupancy = playback.occupancyAt(timeRef.current);
      const tick = (now: number) => {
        const dt = Math.min(now - last, 100) / 1000;
        last = now;
        if (liveRef.current) {
          timeRef.current = wallClockSeconds();
        } else if (playingRef.current) {
          timeRef.current += dt * speedRef.current;
          if (timeRef.current > playback.endTime) timeRef.current = playback.startTime;
        }
        const t = timeRef.current;
        const walking = playback.walkingAt(t);
        if (now - lastOccupancy > OCCUPANCY_REFRESH_MS) {
          occupancy = playback.occupancyAt(t);
          lastOccupancy = now;
          setHud({ time: t, walking: walking.length, occupancy });
        }
        // One placer per frame, shared by every label layer: building labels first, then stations.
        const placer = createPlacer(basemap.project);
        const transit = transitRef.current;
        overlay!.setProps({
          layers: [
            ...(detailedBuildings
              ? buildingModelLayers(detailedBuildings.manifest, detailedBuildings.models, { lightPreset: lightRef.current })
              : []),
            ...crowdLayers({
              footprints: day.buildings,
              buildings: playback.byBuilding(occupancy),
              trips: day.trips,
              time: t,
              speed: speedRef.current,
              selectedId: selectedRef.current,
              placer,
            }),
            ...(transit && showTransitRef.current ? transitLayers({ data: transit.data, feed: transit.feed, now, zoom: basemap.getZoom(), placer, models: transit.models }) : []),
            ...agentLayers(walking, models, t, { zoom: basemap.getZoom() }),
          ],
        });
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    })().catch((err) => setStatus(`Could not start the map: ${err.message}`));

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      transitRef.current?.feed.stop();
      transitRef.current = null;
      basemapRef.current?.remove();
      basemapRef.current = null;
      mapElement.remove();
    };
    // The map is created once; light changes go through setLightPreset below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    basemapRef.current?.setLightPreset(light);
    lightRef.current = light;
  }, [light]);

  useEffect(() => {
    basemapRef.current?.setTrafficVisible(showTraffic);
  }, [showTraffic, mapKind]);

  const goToCampus = (c: Campus) => {
    setCampus(c.id);
    // The Charles River Campus is long and thin and needs the wide default shot; the others fit closer in.
    if (c.id === 'charles-river') basemapRef.current?.flyTo(INITIAL_VIEW.center, INITIAL_VIEW.zoom);
    else basemapRef.current?.flyTo(c.center, 16.4);
  };

  const toggleTransit = () => {
    showTransitRef.current = !showTransitRef.current;
    setShowTransit(showTransitRef.current);
  };

  const leaveLive = () => {
    liveRef.current = false;
    setLive(false);
  };
  const goLive = () => {
    liveRef.current = true;
    setLive(true);
    speedRef.current = 1;
    setSpeed(1);
    playingRef.current = true;
    setPlaying(true);
  };
  const changeSpeed = (s: number) => {
    leaveLive();
    speedRef.current = s;
    setSpeed(s);
  };
  const togglePlaying = () => {
    leaveLive();
    playingRef.current = !playingRef.current;
    setPlaying(playingRef.current);
  };
  const scrub = (t: number) => {
    leaveLive();
    timeRef.current = t;
  };
  const select = (o: Occupancy) => {
    selectedRef.current = o.location.building;
    setSelected(o.location.building);
    basemapRef.current?.flyTo(o.location.position);
  };

  const currentCampus = campuses.find((c) => c.id === campus);
  const ranked = hud
    ? hud.occupancy.filter((o) => (o.location.campus ?? 'charles-river') === campus).sort((a, b) => b.share - a.share)
    : [];
  // Re-read every render (the HUD re-renders twice a second), so "N min" counts down live.
  const transit = transitRef.current;
  const stations = transit?.data.stops.filter((s) => s.kind === 'station' && s.area === campus) ?? [];
  const busArrivals = transit ? nextBuses(transit, campus) : [];
  const shuttleArrivals = transit ? nextBuses(transit, campus, 'shuttle') : [];

  return (
    <div className="app">
      <div ref={containerRef} />

      <header className="panel title">
        <h1>Flowcast</h1>
        <p>
          {currentCampus?.name ?? 'BU'} · Wednesday {hud ? `· ${hud.walking} students walking` : ''}
        </p>
        {campuses.length > 1 && (
          <div className="campuses" role="group" aria-label="Campus">
            {campuses.map((c) => (
              <button key={c.id} onClick={() => goToCampus(c)} aria-pressed={c.id === campus}>
                {c.name.replace(' Campus', '')}
              </button>
            ))}
          </div>
        )}
      </header>

      {status && <div className="panel status" role="status">{status}</div>}

      {mapKind && <CameraControls basemap={basemapRef.current} locations={ranked.map((o) => o.location)} />}

      {hud && (
        <aside className="panel side">
          <div className="tabs" role="tablist" aria-label="Side panel">
            <button role="tab" id="tab-crowds" aria-selected={tab === 'crowds'} aria-controls="panel-crowds" onClick={() => setTab('crowds')}>
              Crowds
            </button>
            <button role="tab" id="tab-transit" aria-selected={tab === 'transit'} aria-controls="panel-transit" onClick={() => setTab('transit')}>
              Transit &amp; traffic
            </button>
          </div>
          {tab === 'crowds' ? (
            <section id="panel-crowds" role="tabpanel" aria-labelledby="tab-crowds">
              <h2>Busiest right now</h2>
              <ol>
                {ranked.slice(0, 8).map((o) => {
                  const level = crowdLevel(o.share);
                  return (
                    <li key={o.location.id}>
                      <button
                        className={o.location.building === selected ? 'row selected' : 'row'}
                        onClick={() => select(o)}
                        aria-pressed={o.location.building === selected}
                      >
                        <span className="name">{o.location.name}</span>
                        <span className="bar" aria-hidden="true">
                          <span style={{ width: `${Math.min(100, o.share * 100)}%`, background: `rgb(${level.glow.slice(0, 3).join(',')})` }} />
                        </span>
                        <span className="value">
                          {Math.round(o.share * 100)}% · {level.label}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </section>
          ) : (
            <section id="panel-transit" role="tabpanel" aria-labelledby="tab-transit">
              <div className="toggles" role="group" aria-label="Map layers">
                <button onClick={toggleTransit} aria-pressed={showTransit}>
                  MBTA
                </button>
                {mapKind === 'mapbox' && (
                  <button onClick={() => setShowTraffic((v) => !v)} aria-pressed={showTraffic}>
                    Traffic
                  </button>
                )}
              </div>
              {transit && showTransit && (
                <>
                  <h2>
                    Live MBTA{' '}
                    <span className="muted">
                      {feedError ?? (feedUpdatedAt ? `· updated ${new Date(feedUpdatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '· connecting…')}
                    </span>
                  </h2>
                  {stations.length > 0 && (
                    <>
                      <h3>
                        {greenBranches(transit, stations).map((b) => (
                          <span key={b} className="route-badge" style={{ background: '#00843D', color: '#fff' }}>
                            {b}
                          </span>
                        ))}{' '}
                        Green Line
                      </h3>
                      <table className="arrivals">
                        <thead>
                          <tr>
                            <th scope="col">Station</th>
                            <th scope="col">Inbound</th>
                            <th scope="col">Outbound</th>
                          </tr>
                        </thead>
                        <tbody>
                          {stations.map((s) => {
                            const next = transit.feed.nextEachWay(s.id);
                            // Name the branch where several stop (Kenmore: B, C, D).
                            const cell = (direction: 0 | 1) => {
                              const a = next[direction];
                              if (!a) return '—';
                              const branch = s.routes.length > 1 ? `${a.route.replace('Green-', '')} ` : '';
                              return `${branch}${minutesUntil(a.time)}`;
                            };
                            return (
                              <tr key={s.id}>
                                <th scope="row">{s.short}</th>
                                <td>{cell(1)}</td>
                                <td>{cell(0)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </>
                  )}
                  {busArrivals.length > 0 && (
                    <>
                      <h3>Buses</h3>
                      <ul className="buses">
                        {busArrivals.map((b) => (
                          <li key={`${b.route}-${b.direction}`}>
                            <span className="route-badge" style={{ background: b.color, color: b.textColor }}>
                              {b.name}
                            </span>
                            <span className="bus-text">
                              {b.directionName} at {b.stop}
                            </span>
                            <strong>{minutesUntil(b.time)}</strong>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {shuttleArrivals.length > 0 && (
                    <>
                      <h3>BU Shuttle</h3>
                      <ul className="buses">
                        {shuttleArrivals.map((b) => (
                          <li key={b.route}>
                            <span className="route-badge" style={{ background: b.color, color: readableOn(b.color) }} aria-hidden="true">
                              BU
                            </span>
                            <span className="bus-text">
                              {b.longName} at {b.stop}
                            </span>
                            <strong>{minutesUntil(b.time)}</strong>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              )}
              {mapKind === 'mapbox' && showTraffic && (
                <>
                  <h3>Traffic</h3>
                  <ul className="legend" aria-label="Traffic legend">
                    {TRAFFIC_LEVELS.map((l) => (
                      <li key={l.key}>
                        <span className="swatch" style={{ background: l.color, height: Math.round(3 * l.boost) }} aria-hidden="true" />
                        {l.label}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}
        </aside>
      )}

      {hud && (
        <footer className="panel timeline">
          <button className="play" onClick={togglePlaying} aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? '❚❚' : '▶'}
          </button>
          <output className="clock" aria-live="off">
            {formatClock(hud.time)}
            {live && <span className="live-badge">LIVE</span>}
          </output>
          <input
            type="range"
            min={range[0]}
            max={range[1]}
            step={60}
            value={hud.time}
            onChange={(e) => scrub(Number(e.target.value))}
            aria-label="Time of day"
            aria-valuetext={formatClock(hud.time)}
          />
          <div className="speeds" role="group" aria-label="Playback speed">
            <button onClick={goLive} aria-pressed={live} title="Follow the real clock: everything moves at true speed">
              Live
            </button>
            {SPEEDS.map((s) => (
              <button key={s} onClick={() => changeSpeed(s)} aria-pressed={!live && speed === s}>
                {s}×
              </button>
            ))}
          </div>
          {mapKind === 'mapbox' && (
            <select value={light} onChange={(e) => setLight(e.target.value as LightPreset)} aria-label="Lighting">
              <option value="dawn">Dawn</option>
              <option value="day">Day</option>
              <option value="dusk">Dusk</option>
              <option value="night">Night</option>
            </select>
          )}
        </footer>
      )}

      {mapKind === 'maplibre' && (
        <p className="panel note">
          Fallback map (no Mapbox token). Set <code>VITE_MAPBOX_TOKEN</code> for textured, lit buildings.
        </p>
      )}
    </div>
  );
}

/** Soonest bus (or BU shuttle) per route and direction at any of a campus's stops. */
function nextBuses({ data, feed }: Transit, area: string, kind: 'bus' | 'shuttle' = 'bus') {
  const routes = new Map(data.routes.map((r) => [r.id, r]));
  const stops = new Map(data.stops.map((s) => [s.id, s]));
  const now = Date.now();
  const best = new Map<string, { route: string; direction: 0 | 1; time: number; stop: string }>();
  for (const a of feed.state.arrivals) {
    if (routes.get(a.route)?.kind !== kind || stops.get(a.stop)?.area !== area || a.time < now - 30_000) continue;
    const key = `${a.route}:${a.direction}`;
    if (!best.has(key) || a.time < best.get(key)!.time) best.set(key, { ...a, stop: stops.get(a.stop)?.short ?? a.stop });
  }
  return [...best.values()]
    .sort((a, b) => a.route.localeCompare(b.route, undefined, { numeric: true }) || a.direction - b.direction)
    .map((a) => {
      const route = routes.get(a.route)!;
      return {
        ...a,
        name: route.name,
        longName: route.longName,
        color: route.color,
        textColor: route.textColor,
        directionName: route.directions[a.direction],
      };
    });
}

/** Green Line branch letters serving these stations: "B", "C"... */
function greenBranches({ data }: Transit, stations: { routes: string[] }[]) {
  const ids = new Set(stations.flatMap((s) => s.routes));
  return data.routes.filter((r) => r.kind === 'subway' && ids.has(r.id)).map((r) => r.name);
}

/** Black or white text, whichever reads better on a hex background (BU's lime Comm Ave line needs black). */
function readableOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.18 ? '#111' : '#fff';
}
