import { useCallback, useEffect, useRef, useState } from 'react';
import { MapboxOverlay } from '@deck.gl/mapbox';
import type { PickingInfo } from '@deck.gl/core';
import { createBasemap, INITIAL_VIEW, TRAFFIC_LEVELS, type Basemap, type LightPreset } from './map/basemap';
import { agentLayers, loadCharacterModels, type LoadedModels } from './layers/agents';
import { crowdLayers, crowdLevel, crowdLevelStyle, modelRoofHeights } from './layers/crowd';
import { BuildingTags, type BuildingTagsHandle } from './BuildingTags';
import { createPlacer } from './layers/placement';
import { buildingModelLayers, loadBuildings } from './layers/buildings';
import { loadMonuments, monumentLayers } from './layers/monuments';
import { loadVehicleModels, transitLayers, transitTooltip, type VehicleModels } from './layers/transit';
import { loadStreet, streetLayers, streetTooltip } from './layers/street';
import { calibrateCapacities } from './sim/calibrate';
import { boatLayers, boatTooltip, loadBoats } from './layers/boats';
import { Playback, formatClock, loadDay, type Campus, type Occupancy, type WalkingAgent } from './sim/playback';
import { MbtaFeed, loadTransit, minutesUntil, type TransitData, type TransitSource } from './transit/mbta';
import { loadShuttles } from './transit/buShuttle';
import { trackCorridors } from './transit/tracks';
import { ScheduledTransit } from './transit/scheduled';
import { dateForWeekday, loadCampusData, WEEKDAYS, type CampusData } from './data/campusData';
import { buildSourceDay } from './sim/sourceDay';
import { SourceDataPanel } from './SourceDataPanel';
import type { DayData, CampusLocation } from './sim/playback';
import { CameraControls } from './CameraControls';
import { PerfMonitor, type PerfCounts } from './PerfMonitor';
import { WeatherControls } from './WeatherControls';
import { adjustOccupancy, weatherImpact, type ActiveWeather } from './weather/weather';
import {
  BikeReplay,
  BluebikesFeed,
  activityCurve,
  estimateDock,
  formatDate,
  loadBikes,
  type BikeData,
  type BikeTrip,
  type DockEstimate,
} from './bikes/bluebikes';
import { bikeLayers, bikeTooltip } from './layers/bikes';
import { ActivityChart } from './ActivityChart';

const SPEEDS = [1, 30, 120, 600];
const params = new URLSearchParams(window.location.search);
// Live by default: the simulated day follows the real clock at 1x, so walkers, trains and buses
// all move at their true relative speeds. ?at= or ?speed= start in playback mode instead.
const START_LIVE = !params.has('at') && !params.has('speed');

const BOSTON_CLOCK = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

/** Seconds since midnight in Boston. */
function wallClockSeconds(): number {
  const now = new Date();
  const parts = BOSTON_CLOCK.format(now).split(':').map(Number);
  return parts[0] * 3600 + parts[1] * 60 + parts[2] + now.getMilliseconds() / 1000;
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
  /** Bluebikes riders on the map, by the campus of the BU dock they left or are heading to. */
  riding: Map<string, number>;
}

interface Transit {
  data: TransitData;
  feed: MbtaFeed; // live MBTA + BU feeds (Live mode)
  schedule: ScheduledTransit; // scheduled service on the sim clock (playback / fast-forward)
  models: VehicleModels;
}

interface Bikes {
  data: BikeData;
  replay: BikeReplay;
  feed: BluebikesFeed;
  campusOf: (trip: BikeTrip) => string;
}

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const basemapRef = useRef<Basemap | null>(null);
  const timeRef = useRef(START_AT);
  const speedRef = useRef(START_SPEED);
  const playingRef = useRef(true);
  const liveRef = useRef(START_LIVE);
  const selectedRef = useRef<string | null>(null);
  const tagsRef = useRef<BuildingTagsHandle>(null);
  const transitRef = useRef<Transit | null>(null);
  const perfRef = useRef<PerfCounts | null>(null); // written each frame, read by PerfMonitor once a second
  const showTransitRef = useRef(true);
  const bikesRef = useRef<Bikes | null>(null);
  const showBikesRef = useRef(true);

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
  const [tab, setTab] = useState<'crowds' | 'data' | 'transit' | 'bikes'>('crowds');
  const [weekday, setWeekday] = useState(2);
  const [sourceData, setSourceData] = useState<CampusData | null>(null);
  const [sourceError, setSourceError] = useState('');
  const baseDayRef = useRef<DayData | null>(null);
  const playbackRef = useRef<Playback | null>(null);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [campus, setCampus] = useState('charles-river');
  const [showTransit, setShowTransit] = useState(true);
  const [showTraffic, setShowTraffic] = useState(true);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [feedUpdatedAt, setFeedUpdatedAt] = useState<number | null>(null);
  const [weather, setWeather] = useState<ActiveWeather | null>(null);
  const weatherRef = useRef<ActiveWeather | null>(null); // read by the frame loop (occupancy nudge)
  const [showBikes, setShowBikes] = useState(true);
  const [bikeFeedError, setBikeFeedError] = useState<string | null>(null);
  const [bikeFeedUpdatedAt, setBikeFeedUpdatedAt] = useState<number | null>(null);

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
      const [basemap, day, models, transitData, vehicleModels, detailedBuildings, street, snapshot, monuments, bikeData, boats] = await Promise.all([
        createBasemap(mapElement, light),
        loadDay('/data/demo-day.json'),
        loadCharacterModels() as Promise<LoadedModels>,
        // Transit and bikes are extras: the campus view must still start if they can't load.
        loadTransit('/data/transit.json').catch(() => null),
        loadVehicleModels().catch(() => ({})),
        // Detailed BU building models; the map still works with Mapbox's plain boxes without them.
        loadBuildings().catch(() => null),
        loadStreet().catch(() => null),
        loadCampusData().catch(() => { setSourceError("Could not load campus data. Showing the demo."); return null; }),
        loadMonuments().catch(() => null),
        loadBikes('/data/bikes.json').catch(() => null),
        loadBoats().catch(() => null), // sailboats on the Charles (river polygon + models)
      ]);
      if (cancelled) return basemap.remove();
      basemapRef.current = basemap;
      setMapKind(basemap.kind);
      const modelled = new Set(detailedBuildings?.manifest.campuses.flatMap((c) => c.buildings.map((b) => b.osm)) ?? []);
      if (detailedBuildings) {
        // Our detailed models replace Mapbox's own copies of those buildings.
        basemap.excludeBuildings([...modelled].map((ref) => Number(ref.split('/')[1])));
      }

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
        transitRef.current = { data: transitData, feed, schedule: new ScheduledTransit(transitData, feed.tracks), models: vehicleModels };
        // Keep the base map's trees off the Green Line trackbed.
        basemap.clipModels(trackCorridors(feed.tracks.filter((t) => t.route.startsWith('Green-')), 3.2));
      }

      if (bikeData) {
        const feed = new BluebikesFeed(bikeData.stations, (state) => {
          setBikeFeedError(state.error);
          setBikeFeedUpdatedAt(state.updatedAt);
        });
        feed.start();
        const dockCampus = new Map(bikeData.stations.map((s) => [s.id, s.campus]));
        // Every replayed ride has at least one BU dock; it belongs to that dock's campus.
        const campusOf = (trip: BikeTrip) => dockCampus.get(trip.from ?? '') ?? dockCampus.get(trip.to ?? '') ?? 'charles-river';
        bikesRef.current = { data: bikeData, replay: new BikeReplay(bikeData), feed, campusOf };
      }

      baseDayRef.current = day;
      setSourceData(snapshot);
      const playback = new Playback(calibrateCapacities(snapshot ? buildSourceDay(day, snapshot, 2) : day));
      playbackRef.current = playback;
      setRange([0, 86400]);
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
          if (id) setTab("data");
        },
        getTooltip: ({ object }: PickingInfo) => {
          const bikes = bikesRef.current;
          const bikeText = bikes ? bikeTooltip(object, bikes.data, bikes.feed, timeRef.current) : null;
          if (bikeText) return bikeText;
          const transit = transitRef.current;
          const streetText = streetTooltip(object, transit);
          if (streetText) return streetText;
          const boatText = boatTooltip(object);
          if (boatText) return boatText;
          const text = transit ? transitTooltip(object, transit.data, liveRef.current ? transit.feed : transit.schedule) : null;
          if (text) return text;
          if (!object || !('bearing' in object) || 'receivedAt' in object) return null;
          const agent = object as WalkingAgent;
          return `Student ${agent.id} → ${playback.locations.find((l) => l.id === agent.to)?.name}`;
        },
      });
      basemap.addControl(overlay);
      // Dev-only handle for poking at layers from the browser console.
      if (import.meta.env.DEV) Object.assign(window, { __flowcast: { overlay, basemap, get playback() { return playbackRef.current; }, transitRef, bikesRef } });
      setStatus('');

      // The crowd glow and tags stand on the detailed models' roofs, not the shorter footprints.
      const roofHeights = modelRoofHeights(detailedBuildings?.manifest);
      let last = performance.now();
      let lastOccupancy = 0;
      let occupancy = playback.occupancyAt(timeRef.current);
      let dockStatus = new Map<string, DockEstimate>(); // Bluebikes at the shown time, refreshed with occupancy
      const tick = (now: number) => {
        const playback = playbackRef.current!;
        const dt = Math.min(now - last, 100) / 1000;
        last = now;
        if (liveRef.current) {
          timeRef.current = wallClockSeconds();
        } else if (playingRef.current) {
          timeRef.current += dt * speedRef.current;
          if (timeRef.current > 86400) timeRef.current = 0;
        }
        const t = timeRef.current;
        const walking = playback.walkingAt(t);
        const bikes = bikesRef.current;
        const riding = bikes ? bikes.replay.ridingAt(t) : [];
        if (now - lastOccupancy > OCCUPANCY_REFRESH_MS) {
          occupancy = adjustOccupancy(playback.occupancyAt(t), weatherRef.current);
          lastOccupancy = now;
          if (bikesRef.current) dockStatus = dockStatusAt(bikesRef.current, liveRef.current ? wallClockSeconds() : t);
          const ridingByCampus = new Map<string, number>();
          for (const r of riding) ridingByCampus.set(bikes!.campusOf(r.trip), (ridingByCampus.get(bikes!.campusOf(r.trip)) ?? 0) + 1);
          setHud({ time: t, walking: walking.length, occupancy, riding: ridingByCampus });
        }
        // One placer per frame, shared by every label layer: building tags first, then stations.
        const placer = createPlacer(basemap.project);
        const buildings = playback.byBuilding(occupancy);
        tagsRef.current?.update({
          buildings,
          footprints: day.buildings,
          locations: day.locations,
          selectedId: selectedRef.current,
          placer,
          project: basemap.project,
          camera: basemap.getCamera(),
          roofHeights,
        });
        const transit = transitRef.current;
        const showBikesNow = bikes && showBikesRef.current;
        const frameLayers = [
          ...(detailedBuildings
            ? buildingModelLayers(detailedBuildings.manifest, detailedBuildings.models, { lightPreset: lightRef.current })
            : []),
          ...crowdLayers({
            // Every tracked building, modelled or not: the glow is light around and on top of
            // the model (at its real height), never a box over it.
            footprints: day.buildings,
            buildings,
            trips: playback.data.trips,
            time: t,
            speed: speedRef.current,
            selectedId: selectedRef.current,
            zoom: basemap.getZoom(),
            roofHeights,
          }),
          ...(street ? streetLayers({ street, transit, time: t, zoom: basemap.getZoom() }) : []),
          ...(transit && showTransitRef.current ? transitLayers({ data: transit.data, feed: transitSourceAt(transit, t, liveRef.current), now, zoom: basemap.getZoom(), placer, models: transit.models }) : []),
          ...(monuments ? monumentLayers(monuments, { zoom: basemap.getZoom(), placer, lightPreset: lightRef.current }) : []),
          ...(boats ? boatLayers({ boats, time: t, zoom: basemap.getZoom(), speed: liveRef.current ? 1 : speedRef.current, lightPreset: lightRef.current }) : []),
          ...(showBikesNow
            ? bikeLayers({ data: bikes.data, trips: bikes.replay.trips, riding, time: t, speed: speedRef.current, zoom: basemap.getZoom(), dockStatus, placer })
            : []),
          ...agentLayers(walking, models, t, { zoom: basemap.getZoom() }),
        ];
        overlay!.setProps({ layers: frameLayers });
        perfRef.current = {
          walkers: walking.length,
          vehicles: transit ? (liveRef.current ? transit.feed.positionsAt(now) : transit.schedule.positionsAt()).length : 0,
          layers: frameLayers.length,
        };
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    })().catch((err) => setStatus(`Could not start the map: ${err.message}`));

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      transitRef.current?.feed.stop();
      transitRef.current = null;
      bikesRef.current?.feed.stop();
      bikesRef.current = null;
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

  const getPerfCounts = useCallback(() => perfRef.current, []);

  const toggleTransit = () => {
    showTransitRef.current = !showTransitRef.current;
    setShowTransit(showTransitRef.current);
  };

  const toggleBikes = () => {
    showBikesRef.current = !showBikesRef.current;
    setShowBikes(showBikesRef.current);
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
  const selectBuilding = (id: string | null) => {
    selectedRef.current = id;
    setSelected(id);
  };
  const select = (o: Occupancy) => {
    selectedRef.current = o.location.building;
    setSelected(o.location.building);
    basemapRef.current?.flyTo(o.location.position);
  };

  const changeDay = (value: number) => {
    if (!baseDayRef.current || !sourceData) return;
    playbackRef.current = new Playback(calibrateCapacities(buildSourceDay(baseDayRef.current, sourceData, value)));
    setWeekday(value);
    setHud((prev) => ({
      time: timeRef.current,
      walking: playbackRef.current!.walkingAt(timeRef.current).length,
      occupancy: playbackRef.current!.occupancyAt(timeRef.current),
      riding: prev?.riding ?? new Map(),
    }));
  };
  const selectSource = (location: CampusLocation) => {
    setCampus(location.campus ?? 'charles-river');
    selectedRef.current = location.building;
    setSelected(location.building);
    basemapRef.current?.flyTo(location.position);
  };
  const currentCampus = campuses.find((c) => c.id === campus);
  const ranked = hud
    ? hud.occupancy.filter((o) => (o.location.campus ?? 'charles-river') === campus).sort((a, b) => b.share - a.share)
    : [];
  // Re-read every render (the HUD re-renders twice a second), so "N min" counts down live.
  const transit = transitRef.current;
  const stations = transit?.data.stops.filter((s) => s.kind === 'station' && s.area === campus) ?? [];
  // The panel follows the same source as the map: live feeds, or the schedule when playing back.
  const source: TransitSource | null = transit ? (live ? transit.feed : transit.schedule) : null;
  const busArrivals = transit && source ? nextBuses(transit.data, source, campus) : [];
  const shuttleArrivals = transit && source ? nextBuses(transit.data, source, campus, 'shuttle') : [];
  const bikes = bikesRef.current;
  const docks = bikes?.data.stations.filter((s) => s.campus === campus) ?? [];
  const ridingHere = hud?.riding.get(campus) ?? 0;

  return (
    <div className="app">
      <div ref={containerRef} />
      <BuildingTags ref={tagsRef} onSelect={selectBuilding} />

      <header className="panel title">
        <h1>Flowcast</h1>
        <p>
          {currentCampus?.name ?? 'BU'} · {WEEKDAYS[weekday]} {hud ? `· ${hud.walking} walking` : ''}
          {bikes && showBikes && hud ? ` · ${ridingHere} on Bluebikes` : ''}
        </p>
        <p className="model-note">{sourceData ? 'Campus simulation · Fall 2026' : 'Campus simulation · Demo'}</p>
        {sourceData && <p className="model-note">{dateForWeekday(sourceData, weekday)} · Boston time</p>}
        {sourceError && <p role="alert">{sourceError}</p>}
        {sourceData && <label className="day-picker">Simulation day <select aria-label="Simulation day" value={weekday} onChange={(event) => changeDay(Number(event.target.value))}>{WEEKDAYS.map((name, index) => <option key={name} value={index}>{name}</option>)}</select></label>}
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

      <PerfMonitor counts={getPerfCounts} />
      {mapKind && <CameraControls basemap={basemapRef.current} locations={ranked.map((o) => o.location)} />}
      {mapKind && <WeatherControls basemap={basemapRef.current} light={light} onChange={(w) => { weatherRef.current = w; setWeather(w); }} />}

      {hud && (
        <aside className="panel side">
          <div className="tabs" role="tablist" aria-label="Side panel">
            <button role="tab" id="tab-crowds" aria-selected={tab === 'crowds'} aria-controls="panel-crowds" onClick={() => setTab('crowds')}>
              Crowds
            </button>
            <button role="tab" id="tab-data" aria-selected={tab === 'data'} aria-controls="panel-data" onClick={() => setTab('data')}>Data</button>
            <button role="tab" id="tab-transit" aria-selected={tab === 'transit'} aria-controls="panel-transit" onClick={() => setTab('transit')}>
              Transit &amp; traffic
            </button>
            {bikes && (
              <button role="tab" id="tab-bikes" aria-selected={tab === 'bikes'} aria-controls="panel-bikes" onClick={() => setTab('bikes')}>
                Bikes
              </button>
            )}
          </div>
          {tab === 'crowds' ? (
            <section id="panel-crowds" role="tabpanel" aria-labelledby="tab-crowds">
              {weather && <WeatherImpact weather={weather} />}
              <h2>Campus activity</h2>
              <ol>
                {ranked.slice(0, 8).map((o) => {
                  const level = crowdLevel(o.share);
                  return (
                    <li key={o.location.id}>
                      <button
                        className={o.location.building === selected ? 'row selected' : 'row'}
                        onClick={() => select(o)}
                        aria-pressed={o.location.building === selected}
                        style={crowdLevelStyle(o.share)}
                      >
                        <span className="name">{o.location.name}</span>
                        <span className="bar" aria-hidden="true">
                          <span style={{ width: `${Math.min(100, o.share * 100)}%` }} />
                        </span>
                        <span className="value">
                          <b>{Math.round(o.share * 100)}%</b> · {level.label}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </section>
          ) : tab === 'bikes' && bikes ? (
            <section id="panel-bikes" role="tabpanel" aria-labelledby="tab-bikes">
              <div className="toggles" role="group" aria-label="Map layers">
                <button onClick={toggleBikes} aria-pressed={showBikes}>
                  Bluebikes
                </button>
              </div>
              <h2>
                Real Bluebikes rides <span className="muted">· {formatDate(bikes.data.replayDate)}</span>
              </h2>
              <p className="bike-summary">
                <strong>{ridingHere}</strong> riding to or from {currentCampus?.name.replace(' Campus', '') ?? 'BU'} docks now ·{' '}
                {bikes.replay.trips.filter((t) => bikes.campusOf(t) === campus).length.toLocaleString()} rides that day
              </p>
              {docks.length > 0 && (
                <>
                  <h3>Typical {bikes.data.weekday} at these docks</h3>
                  <ActivityChart
                    values={activityCurve(docks, bikes.data.binSeconds)}
                    binSeconds={bikes.data.binSeconds}
                    time={hud.time}
                    unit="rides/h"
                    label={`Rides docked and undocked per hour at ${currentCampus?.name ?? 'BU'} Bluebikes docks on a typical ${bikes.data.weekday}`}
                  />
                  <p className="muted">
                    Docked + undocked per hour, averaged over {bikes.data.profileDates.length} {bikes.data.weekday}s in{' '}
                    {new Date(`${bikes.data.month}-15T12:00:00`).toLocaleDateString([], { month: 'long', year: 'numeric' })}
                  </p>
                  <h3>
                    {live ? 'Live docks' : `Docks at ${hud ? formatClock(hud.time) : ''} (estimated)`}{' '}
                    <span className="muted">
                      {bikeFeedError ??
                        (bikeFeedUpdatedAt ? `· updated ${new Date(bikeFeedUpdatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '· connecting…')}
                    </span>
                  </h3>
                  <table className="arrivals">
                    <thead>
                      <tr>
                        <th scope="col">Dock</th>
                        <th scope="col">Bikes</th>
                        <th scope="col">Empty</th>
                        <th scope="col" title="Estimated bikes in 1 hour">+1 h</th>
                        <th scope="col" title="Estimated bikes in 3 hours">+3 h</th>
                      </tr>
                    </thead>
                    <tbody>
                      {docks.map((s) => {
                        // "Now" is the shown time: the live count in Live mode, else an estimate.
                        const shown = hud ? (live ? wallClockSeconds() : hud.time) : wallClockSeconds();
                        const at = (offset: number) => estimateDock(s, bikes.feed.status(s), bikes.data.binSeconds, wallClockSeconds(), shown + offset);
                        const nowEst = at(0);
                        const mark = (e: DockEstimate) => (e.estimated ? '≈' : '');
                        return (
                          <tr key={s.id}>
                            <th scope="row">{s.short}</th>
                            <td>
                              {mark(nowEst)}
                              {nowEst.bikes}
                              {nowEst.ebikes > 0 && <span className="muted"> ({nowEst.ebikes}⚡)</span>}
                            </td>
                            <td>
                              {mark(nowEst)}
                              {nowEst.docks}
                            </td>
                            <td>≈{at(3600).bikes}</td>
                            <td>≈{at(3 * 3600).bikes}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <p className="muted source">
                    ≈ estimated: today's live count plus a typical {bikes.data.weekday}'s arrivals and departures at each dock. Bluebikes'
                    rebalancing vans aren't modelled. ⚡ = e-bikes.
                  </p>
                </>
              )}
              <p className="muted source">
                Bluebikes System Data and live feed. Docks within {bikes.data.stationRadiusMetres} m of a BU building. Ride times at BU docks are real;
                street routes are inferred.
              </p>
            </section>
          ) : tab === 'data' ? (
            <section id="panel-data" role="tabpanel" aria-labelledby="tab-data">
              {sourceData && baseDayRef.current ? <SourceDataPanel data={sourceData} locations={baseDayRef.current.locations} selectedBuilding={selected} campus={campus} weekday={weekday} time={hud.time} onSelect={selectSource} /> : <p>Campus data could not be loaded.</p>}
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
                    {live ? 'Live MBTA' : 'Scheduled service'}{' '}
                    <span className="muted">
                      {live
                        ? (feedError ?? (feedUpdatedAt ? `· updated ${new Date(feedUpdatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '· connecting…'))
                        : '· playback timetable'}
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
                            // Trains only: Kenmore is also a stop for the 57 and other buses.
                            const next: Partial<Record<0 | 1, { route: string; time: number }>> = {};
                            for (const a of source!.nextArrivals(s.id)) {
                              if (a.route.startsWith('Green-') && (!next[a.direction] || a.time < next[a.direction]!.time)) next[a.direction] = a;
                            }
                            // Name the branch where several stop (Kenmore: B, C, D).
                            const cell = (direction: 0 | 1) => {
                              const a = next[direction];
                              if (!a) return '—';
                              const branch = s.routes.filter((r) => r.startsWith('Green-')).length > 1 ? `${a.route.replace('Green-', '')} ` : '';
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
            {live && <span className="live-badge">CLOCK</span>}
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
            <button onClick={goLive} aria-pressed={live} title="Follow Boston time and live transit">
              Clock
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


    </div>
  );
}

/** One line on how the weather changes campus routines (plan Section 5.6), and what the map adjusts for it. */
function WeatherImpact({ weather }: { weather: ActiveWeather }) {
  const { note, boost } = weatherImpact(weather.condition);
  return (
    <p className="weather-impact">
      <strong>Weather impact:</strong> {note}.
      <span className="muted">
        {weather.live ? 'Live weather' : 'Simulated weather'}
        {boost > 0 && ` · dining and library activity +${Math.round(boost * 100)}%`}
      </span>
    </p>
  );
}

/** Soonest bus (or BU shuttle) per route and direction at any of a campus's stops. */
function nextBuses(data: TransitData, feed: TransitSource, area: string, kind: 'bus' | 'shuttle' = 'bus') {
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

/**
 * Live mode draws the real MBTA and BU feeds. When the day is played back or fast-forwarded,
 * live vehicles can't keep up, so scheduled service on the simulation clock takes over.
 */
function transitSourceAt(transit: Transit, t: number, live: boolean): TransitSource {
  if (live) return transit.feed;
  transit.schedule.setTime(t);
  return transit.schedule;
}

/** Bikes and empty docks at every BU dock at `target` (sim seconds): live if that's now, else estimated. */
function dockStatusAt({ data, feed }: Bikes, target: number): Map<string, DockEstimate> {
  const now = wallClockSeconds();
  return new Map(data.stations.map((s) => [s.id, estimateDock(s, feed.status(s), data.binSeconds, now, target)]));
}
