import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapboxOverlay } from '@deck.gl/mapbox';
import type { PickingInfo } from '@deck.gl/core';
import { createBasemap, INITIAL_VIEW, TRAFFIC_LEVELS, type Basemap, type LightPreset } from './map/basemap';
import { agentLayers, loadCharacterModels, type LoadedModels } from './layers/agents';
import { crowdLayers, crowdLevel, crowdLevelStyle, modelRoofHeights, type RoofHeights } from './layers/crowd';
import { BuildingTags, type BuildingTagsHandle } from './BuildingTags';
import { TransitTags, type TagMarker, type TransitTagsHandle } from './TransitTags';
import { PlaceTags, placeHitLayers, placeUnder, type PlaceTagsHandle } from './PlaceTags';
import { createPlacer } from './layers/placement';
import { cullLayers } from './layers/culling';
import { buildingModelLayers, loadBuildings } from './layers/buildings';
import { daylightAt, daylightLabel } from './map/daylight';
import { loadMonuments, monumentLayers } from './layers/monuments';
import { fieldBuildingIds, fieldLayers, loadFields } from './layers/fields';
import { loadVehicleModels, transitLayers, transitTooltip, type VehicleModels } from './layers/transit';
import { loadStreet, streetLayers, streetTooltip } from './layers/street';
import { boatLayers, boatTooltip, loadBoats } from './layers/boats';
import { Playback, formatClock, loadDay, type BuildingFootprint, type BuildingOccupancy, type Campus, type Occupancy, type WalkingAgent } from './sim/playback';
import { MbtaFeed, loadTransit, minutesUntil, type TransitData, type TransitSource } from './transit/mbta';
import { loadShuttles } from './transit/buShuttle';
import { trackCorridors } from './transit/tracks';
import { PublishedTransit, loadPublishedSchedule } from './transit/publishedSchedule';
import { buildPopulation, loadPopulation, type PopulationBase } from './sim/population';
import { advanceTime } from './sim/clock';
import { dateForWeekday, loadCampusData, WEEKDAYS, type CampusData } from './data/campusData';
import { buildSourceDay } from './sim/sourceDay';
import { SourceDataPanel } from './SourceDataPanel';
import type { CampusLocation } from './sim/playback';
import { CameraControls } from './CameraControls';
import { PerfMonitor, type PerfCounts } from './PerfMonitor';
import { WeatherControls } from './WeatherControls';
import { activeWindFromDegrees } from './weather/weather';
import { adjustOccupancy, weatherImpact, type ActiveWeather } from './weather/weather';
import { calibrateCapacities } from './sim/calibrate';
import { riderLayers, withRiders } from './layers/riders';
import { RiderSim } from './sim/riders';
import { precipitationLayers, setParticleScale } from './weather/precipitation';
import { quality } from './perf/quality';
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
import { bikeLayers, bikeTooltip, loadBikeModels } from './layers/bikes';
import { ActivityChart } from './ActivityChart';
import { loadMobility, mobilityAt, type MobilityData, type MobilityMode, type MobilityView, type MobilityPoint, type MobilityArc } from './data/mobility';
import { mobilityLayers, mobilityTooltip } from './layers/mobility';
import { MobilityPanel } from './MobilityPanel';

// The HUD re-renders the app twice a second; these only need to when their own props change.
const MemoPerfMonitor = memo(PerfMonitor);
const MemoCameraControls = memo(CameraControls);
const MemoWeatherControls = memo(WeatherControls);

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

const BOSTON_WEEKDAY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' });
function wallClockWeekday(): number { return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(BOSTON_WEEKDAY.format(new Date())); }
const START_WEEKDAY = START_LIVE ? wallClockWeekday() : 2;
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
  schedule: PublishedTransit | null; // scheduled service on the sim clock (playback / fast-forward)
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
  const transitTagsRef = useRef<TransitTagsHandle>(null);
  const placeTagsRef = useRef<PlaceTagsHandle>(null);
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
  // 'auto' (default) follows the sun at the shown time: real Boston time in Clock mode.
  const [light, setLight] = useState<LightPreset | 'auto'>('auto');
  const [autoPreset, setAutoPreset] = useState<LightPreset>(() => daylightAt(START_AT).preset);
  const shownLight = light === 'auto' ? autoPreset : light;
  const lightRef = useRef<LightPreset>(shownLight); // current preset, read by the frame loop (layer tints)
  const lightModeRef = useRef<LightPreset | 'auto'>('auto');
  const veilRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<'crowds' | 'data' | 'transit' | 'bikes' | 'traffic'>('crowds');
  const [weekday, setWeekday] = useState(START_WEEKDAY);
  const weekdayRef = useRef(START_WEEKDAY); // 0 = Monday (the day picker's index), read by the frame loop
  const [sourceData, setSourceData] = useState<CampusData | null>(null);
  const [scheduleError, setScheduleError] = useState('');
  const baseDayRef = useRef<PopulationBase | null>(null);
  const playbackRef = useRef<Playback | null>(null);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [campus, setCampus] = useState('charles-river');
  const campusRef = useRef('charles-river');
  const [mobilityData, setMobilityData] = useState<MobilityData | null>(null);
  const [mobilityView, setMobilityView] = useState<MobilityView | null>(null);
  const [mobilityMode, setMobilityMode] = useState<MobilityMode>('roads');
  const mobilityModeRef = useRef<MobilityMode>('roads');
  const [mobilityError, setMobilityError] = useState<string | null>(null);
  const [selectedMobility, setSelectedMobility] = useState<string | null>(null);
  const selectedMobilityRef = useRef<string | null>(null);
  const [showTransit, setShowTransit] = useState(true);
  // Car traffic is off by default: most students walk, bike or take the T. Still available in the Transit tab.
  const [showTraffic, setShowTraffic] = useState(false);
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
      const [basemap, day, models, transitData, vehicleModels, detailedBuildings, street, snapshot, monuments, bikeData, boats, population, timetable, mobilitySnapshot, fields] = await Promise.all([
        createBasemap(mapElement, shownLight),
        loadDay('/data/demo-day.json'),
        loadCharacterModels() as Promise<LoadedModels>,
        // Transit and bikes are extras: the campus view must still start if they can't load.
        loadTransit('/data/transit.json').catch(() => null),
        loadVehicleModels().catch(() => ({})),
        // Detailed BU building models; the map still works with Mapbox's plain boxes without them.
        loadBuildings().catch(() => null),
        loadStreet().catch(() => null),
        loadCampusData(),
        loadMonuments().catch(() => null),
        loadBikes('/data/bikes.json').catch(() => null),
        loadBoats().catch(() => null), // sailboats on the Charles (river polygon + models)
        loadPopulation(),
        loadPublishedSchedule().catch((error: Error) => { setScheduleError(error.message); return null; }),
        loadMobility().catch((error: Error) => { setMobilityError(error.message); return null; }),
        loadFields().catch(() => null),
        loadBikeModels().catch(() => null), // Bluebikes riders; plain blocks without them
      ]);
      if (cancelled) return basemap.remove();
      basemapRef.current = basemap;
      setMapKind(basemap.kind);
      const modelled = new Set(detailedBuildings?.manifest.campuses.flatMap((c) => c.buildings.map((b) => b.osm)) ?? []);
      // Draw the city's buildings, leaving out the ones we have detailed models for (always called:
      // Standard's own 3D buildings are off).
      basemap.excludeBuildings([...modelled].map((ref) => Number(ref.split('/')[1])).concat(fields ? fieldBuildingIds(fields) : []));

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
        transitRef.current = { data: transitData, feed, schedule: timetable ? new PublishedTransit(transitData, feed.tracks, timetable) : null, models: vehicleModels };
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

      const populationBase = buildPopulation(day, snapshot, population);
      baseDayRef.current = populationBase;
      setSourceData(snapshot);
      setMobilityData(mobilitySnapshot);
      // Capacities sized to the loaded day so % full never goes above 100 (sim/calibrate.ts).
      const playback = new Playback(calibrateCapacities(buildSourceDay(populationBase, snapshot, weekdayRef.current)));
      playbackRef.current = playback;
      setRange([0, 86400]);
      setCampuses(day.campuses ?? []);

      // What a map pointer is over, for the tags that expand on hover (and on tap, for touch).
      const buildingUnder = (object: unknown) =>
        object && typeof object === 'object' && ('polygon' in object || 'share' in object) ? (object as unknown as { id: string }).id : null;
      const markerUnder = (object: unknown): TagMarker =>
        !object || typeof object !== 'object' ? null
        : 'platforms' in object ? { kind: 'stop', id: (object as unknown as { id: string }).id }
        : 'gbfsId' in object ? { kind: 'dock', id: (object as unknown as { id: string }).id }
        : null;
      overlay = new MapboxOverlay({
        interleaved: new URLSearchParams(window.location.search).get('interleaved') !== '0',
        _animate: true, // keeps the walk cycles ticking between data updates
        // Skips drawing models that are wholly off-screen (see layers/culling.ts).
        layerFilter: cullLayers,
        // Hovering a building or a stop/dock dot expands its tag.
        onHover: ({ object }: PickingInfo) => {
          tagsRef.current?.hoverBuilding(buildingUnder(object));
          transitTagsRef.current?.hoverMarker(markerUnder(object));
          placeTagsRef.current?.hoverPlace(placeUnder(object));
        },
        // Building footprints and labels both carry the building id; anything else clears.
        onClick: ({ object }: PickingInfo) => {
          if (object && 'mobilityKind' in object) {
            selectedMobilityRef.current = object.id;
            setSelectedMobility(object.id);
            setTab('traffic');
            return;
          }
          // A vehicle pins its tag; anything else unpins it.
          transitTagsRef.current?.pinVehicle(object && 'receivedAt' in object ? (object as { id: string }).id : null);
          // Touch has no hover: a tap opens the stop's or dock's tag (a tapped building's tag opens
          // because it's selected).
          transitTagsRef.current?.hoverMarker(markerUnder(object));
          placeTagsRef.current?.hoverPlace(placeUnder(object));
          const isBuilding = object && ('polygon' in object || 'share' in object);
          const id = isBuilding ? (object as { id: string }).id : null;
          selectedRef.current = id;
          setSelected(id);
          if (id) setTab("data");
        },
        getTooltip: ({ object }: PickingInfo) => {
          const countTooltip = mobilityTooltip(object);
          if (countTooltip) return countTooltip;
          // Vehicles get a floating glass tag (TransitTags) instead of the tooltip.
          const vehicleId = object && 'receivedAt' in object ? (object as { id: string }).id : null;
          transitTagsRef.current?.hoverVehicle(vehicleId);
          if (vehicleId) return null;
          // Stops and docks with a tag expand it instead of showing a tooltip.
          const marker = markerUnder(object);
          if (marker && transitTagsRef.current?.hasTag(marker)) return null;
          // Places (monuments, open spaces, fields) open their tag instead.
          if (placeUnder(object)) return null;
          const bikes = bikesRef.current;
          const bikeText = bikes ? bikeTooltip(object, bikes.data, bikes.feed, timeRef.current) : null;
          if (bikeText) return bikeText;
          const transit = transitRef.current;
          const streetText = streetTooltip(object, transit);
          if (streetText) return streetText;
          const boatText = boatTooltip(object);
          if (boatText) return boatText;
          const source = transit && (liveRef.current ? transit.feed : transit.schedule);
          const text = transit && source ? transitTooltip(object, transit.data, source) : null;
          if (text) return text;
          if (!object || !('bearing' in object) || 'receivedAt' in object) return null;
          const agent = object as WalkingAgent;
          // Riders walking to a stop are headed for a transit stop, not a building.
          return `Student ${agent.id} → ${playback.locations.find((l) => l.id === agent.to)?.name ?? transit?.data.stops.find((s) => s.id === agent.to)?.short}`;
        },
      });
      basemap.addControl(overlay);
      // Dev-only handle for poking at layers from the browser console.
      if (import.meta.env.DEV) Object.assign(window, { __flowcast: { overlay, basemap, get playback() { return playbackRef.current; }, get time() { return timeRef.current; }, transitRef, bikesRef, populationBase, quality } });
      setStatus('');

      // The crowd glow and tags stand on the detailed models' roofs, not the shorter footprints.
      const roofHeights = modelRoofHeights(detailedBuildings?.manifest);
      let last = performance.now();
      let lastOccupancy = 0;
      let occupancy = adjustOccupancy(playback.occupancyAt(timeRef.current), weatherRef.current);
      // People getting on and off trains, buses and shuttles at stops near campus.
      const riders = transitRef.current ? new RiderSim(day, transitRef.current.data, transitRef.current.feed.tracks) : null;
      let mobilityKey = '';
      let currentMobility: MobilityView | null = null;
      let buildings: BuildingOccupancy[] = [];
      let buildingsFrom: Occupancy[] | null = null;
      let buildingsPlayback: Playback | null = null;
      let dockStatus = new Map<string, DockEstimate>(); // Bluebikes at the shown time, refreshed with occupancy
      const tick = (now: number) => {
        const elapsed = now - last;
        last = now;
        let nextDay = weekdayRef.current;
        if (liveRef.current) {
          nextDay = wallClockWeekday();
          timeRef.current = wallClockSeconds();
        } else if (playingRef.current) {
          const passedDays = Math.floor((timeRef.current + Math.max(0, elapsed) * speedRef.current / 1000) / 86400);
          nextDay = (nextDay + passedDays) % 7;
          timeRef.current = advanceTime(timeRef.current, elapsed, speedRef.current);
        }
        if (nextDay !== weekdayRef.current) {
          weekdayRef.current = nextDay;
          setWeekday(nextDay);
          playbackRef.current = new Playback(calibrateCapacities(buildSourceDay(populationBase, snapshot, nextDay)));
          lastOccupancy = 0;
        }
        const playback = playbackRef.current!;
        const t = timeRef.current;
        if (lightModeRef.current === 'auto') {
          // Mapbox Standard has four presets: pick one by the sun (cached per sim half-minute) and set
          // the veil in the same frame, so the switch itself doesn't flash.
          const { preset, veil } = daylightAt(t);
          if (veilRef.current) veilRef.current.style.opacity = String(veil);
          if (preset !== lightRef.current) {
            lightRef.current = preset;
            basemap.setLightPreset(preset);
            setAutoPreset(preset);
          }
        }
        const nextMobilityKey = `${mobilityModeRef.current}:${campusRef.current}:${weekdayRef.current}:${Math.floor(t / 3600)}`;
        if (mobilitySnapshot && nextMobilityKey !== mobilityKey) {
          currentMobility = mobilityAt(mobilitySnapshot, mobilityModeRef.current, campusRef.current, weekdayRef.current, t);
          mobilityKey = nextMobilityKey;
          setMobilityView(currentMobility);
        }
        // Performance setting (perf/quality.ts): Auto watches these frame times.
        quality.frame(now);
        const q = quality.settings;
        setParticleScale(q.particles);
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
        // Rolled up per building only when occupancy is refreshed (or the day changes), not every frame.
        if (occupancy !== buildingsFrom || playback !== buildingsPlayback) {
          buildings = splitSharedTags(playback.byBuilding(occupancy), occupancy, day.buildings, roofHeights);
          buildingsFrom = occupancy;
          buildingsPlayback = playback;
        }
        tagsRef.current?.update({
          buildings,
          footprints: day.buildings,
          locations: populationBase.locations,
          selectedId: selectedRef.current,
          placer,
          project: basemap.project,
          camera: basemap.getCamera(),
          roofHeights,
        });
        const transit = transitRef.current;
        // Live feeds and published playback share the rendering interface.
        const source = transit ? transitSourceAt(transit, t, liveRef.current, weekdayRef.current) : null;
        if (riders && source) riders.step(t, now, source);
        const showBikesNow = bikes && showBikesRef.current;
        // Shown time and day (0 = Sunday), for BU shuttle service hours.
        const serviceTime = liveRef.current ? wallClockSeconds() : t;
        const serviceDay = liveRef.current ? new Date().getDay() : (weekdayRef.current + 1) % 7;
        // Then station, stop and dock tags, through the same placer.
        transitTagsRef.current?.update({
          placer,
          project: basemap.project,
          zoom: basemap.getZoom(),
          transit: transit && source && showTransitRef.current ? { data: transit.data, source, now, time: serviceTime, weekday: serviceDay } : null,
          bikes: showBikesNow ? { stations: bikes.data.stations, dockStatus } : null,
        });
        // Then monuments, artworks, open spaces and fields.
        placeTagsRef.current?.update({
          placer,
          project: basemap.project,
          camera: basemap.getCamera(),
          monuments: monuments?.monuments ?? null,
          fields: fields?.fields ?? null,
        });
        const frameLayers = [
          ...(detailedBuildings
            ? buildingModelLayers(detailedBuildings.manifest, detailedBuildings.models, { lightPreset: lightRef.current, clock: t, auto: lightModeRef.current === 'auto', litWindows: q.litWindows })
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
          ...(transit && source && showTransitRef.current ? transitLayers({ data: transit.data, feed: source, now, zoom: basemap.getZoom(), models: transit.models, time: serviceTime, weekday: serviceDay }) : []),
          ...(monuments ? monumentLayers(monuments, { zoom: basemap.getZoom(), lightPreset: lightRef.current, time: serviceTime }) : []),
          ...(fields ? fieldLayers(fields, { zoom: basemap.getZoom(), lightPreset: lightRef.current }) : []),
          ...placeHitLayers(monuments?.monuments ?? null, fields?.fields ?? null, basemap.getZoom()),
          ...(boats && sailingWeather(weatherRef.current, lightRef.current) ? boatLayers({ boats, time: t, zoom: basemap.getZoom(), speed: liveRef.current ? 1 : speedRef.current, lightPreset: lightRef.current, windFromDegrees: boatWind() }) : []),
          ...(showBikesNow
            ? bikeLayers({ data: bikes.data, trips: bikes.replay.trips, riding, time: t, speed: speedRef.current, zoom: basemap.getZoom(), dockStatus })
            : []),
          ...agentLayers(nearView(withRiders(walking, riders, showTransitRef.current), basemap.getCamera().center, q.walkerRadius), models, t, { zoom: basemap.getZoom() }),
          ...(riders && showTransitRef.current ? riderLayers(riders, models, t, basemap.getZoom()) : []),
          ...(currentMobility ? mobilityLayers(currentMobility, { selectedId: selectedMobilityRef.current, placer }) : []),
          ...precipitationLayers(weatherRef.current?.effect.precipitation, basemap.getCamera(), now, lightRef.current),
        ];
        overlay!.setProps({ layers: frameLayers });
        perfRef.current = {
          walkers: walking.length,
          vehicles: source ? source.positionsAt(now).length : 0,
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
    lightModeRef.current = light;
    const preset = light === 'auto' ? daylightAt(timeRef.current).preset : light;
    basemapRef.current?.setLightPreset(preset);
    lightRef.current = preset;
    if (light === 'auto') setAutoPreset(preset);
  }, [light]);

  useEffect(() => {
    basemapRef.current?.setTrafficVisible(showTraffic);
  }, [showTraffic, mapKind]);

  useEffect(() => { campusRef.current = campus; }, [campus]);

  const goToCampus = (c: Campus) => {
    setCampus(c.id);
    // The Charles River Campus is long and thin and needs the wide default shot; the others fit closer in.
    if (c.id === 'charles-river') basemapRef.current?.flyTo(INITIAL_VIEW.center, INITIAL_VIEW.zoom);
    else basemapRef.current?.flyTo(c.center, 16.4);
  };

  const getPerfCounts = useCallback(() => perfRef.current, []);
  const onWeather = useCallback((w: ActiveWeather) => {
    weatherRef.current = w;
    setWeather(w);
  }, []);

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
    leaveLive();
    playbackRef.current = new Playback(calibrateCapacities(buildSourceDay(baseDayRef.current, sourceData, value)));
    setWeekday(value);
    weekdayRef.current = value;
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
  const changeMobilityMode = (mode: MobilityMode) => {
    mobilityModeRef.current = mode;
    setMobilityMode(mode);
    selectedMobilityRef.current = null;
    setSelectedMobility(null);
  };
  const selectMobility = (item: MobilityPoint | MobilityArc) => {
    selectedMobilityRef.current = item.id;
    setSelectedMobility(item.id);
    const position: [number, number] = item.mobilityKind === 'flow'
      ? [(item.from[0] + item.to[0]) / 2, (item.from[1] + item.to[1]) / 2]
      : item.position;
    basemapRef.current?.flyTo(position, 16);
  };
  const currentCampus = campuses.find((c) => c.id === campus);
  const ranked = hud
    ? hud.occupancy.filter((o) => (o.location.campus ?? 'charles-river') === campus).sort((a, b) => b.share - a.share)
    : [];
  // The camera tour only cares which places are in the campus (it re-picks when that set changes),
  // so it gets a new list only then, not on every HUD refresh.
  const tourKey = ranked.map((o) => o.location.id).sort().join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tourLocations = useMemo(() => ranked.map((o) => o.location), [tourKey]);
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
      {light === 'auto' && hud && (
        // Auto lighting: a blue multiply veil darkens the chosen preset to the sun's brightness (set per frame).
        <div ref={veilRef} aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: 'rgb(18, 24, 52)',
          mixBlendMode: 'multiply', opacity: daylightAt(hud.time).veil }} />
      )}
      <BuildingTags ref={tagsRef} onSelect={selectBuilding} />
      <TransitTags ref={transitTagsRef} />
      <PlaceTags ref={placeTagsRef} />

      <header className="panel title">
        <h1>Flowcast</h1>
        <p>
          {currentCampus?.name ?? 'BU'} · {WEEKDAYS[weekday]} {hud ? `· ${hud.walking} walking` : ''}
          {bikes && showBikes && hud ? ` · ${ridingHere} on Bluebikes` : ''}
        </p>
        <p className="model-note">{sourceData ? 'Campus simulation · Fall 2026' : 'Campus simulation · Demo'}</p>
        {sourceData && <p className="model-note">{dateForWeekday(sourceData, weekday)} · Boston time</p>}
        {!live && scheduleError && <p role="alert">Transit playback unavailable: {scheduleError}</p>}
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

      <MemoPerfMonitor counts={getPerfCounts} />
      {mapKind && <MemoCameraControls basemap={basemapRef.current} locations={tourLocations} />}
      {mapKind && <MemoWeatherControls basemap={basemapRef.current} light={shownLight} simTime={hud?.time} live={live} onChange={onWeather} />}

      {hud && (
        <aside className="panel side">
          <div className="tabs mobility-tabs" role="tablist" aria-label="Side panel">
            <button role="tab" id="tab-crowds" aria-selected={tab === 'crowds'} aria-controls="panel-crowds" onClick={() => setTab('crowds')}>
              Crowds
            </button>
            <button role="tab" id="tab-data" aria-selected={tab === 'data'} aria-controls="panel-data" onClick={() => setTab('data')}>Data</button>
            <button role="tab" id="tab-transit" aria-selected={tab === 'transit'} aria-controls="panel-transit" onClick={() => setTab('transit')}>
              Transit
            </button>
            <button role="tab" id="tab-traffic" aria-selected={tab === 'traffic'} aria-controls="panel-traffic" onClick={() => setTab('traffic')}>Traffic</button>
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
          ) : tab === 'traffic' ? (
            <section id="panel-traffic" role="tabpanel" aria-labelledby="tab-traffic">
              <MobilityPanel data={mobilityData} view={mobilityView} mode={mobilityMode} weekday={weekday} selected={selectedMobility} onMode={changeMobilityMode} onSelect={selectMobility} error={mobilityError} />
            </section>
          ) : tab === 'data' ? (
            <section id="panel-data" role="tabpanel" aria-labelledby="tab-data">
              {baseDayRef.current && <p>{baseDayRef.current.populationSummary.total.toLocaleString()} students · {baseDayRef.current.populationSummary.reportingPeriod}. Students outside the study area remain off map.</p>}
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
              {transit && source && showTransit && (
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
            <select value={light} onChange={(e) => setLight(e.target.value as LightPreset | 'auto')} aria-label="Lighting">
              <option value="auto">Auto</option>
              <option value="dawn">Dawn</option>
              <option value="day">Day</option>
              <option value="dusk">Dusk</option>
              <option value="night">Night</option>
            </select>
          )}
          {mapKind === 'mapbox' && light === 'auto' && hud && (
            <span className="light-status" style={{ fontSize: 12, opacity: 0.85, whiteSpace: 'nowrap' }} title={live ? 'Following Boston time' : 'Following the shown time'}>
              Auto · {daylightLabel(hud.time)}
            </span>
          )}
        </footer>
      )}


    </div>
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

/** Walkers within `radius` metres of the view centre (all of them when radius is null). */
function nearView(walkers: WalkingAgent[], center: [number, number], radius: number | null): WalkingAgent[] {
  if (radius === null) return walkers;
  const kx = 111_320 * Math.cos((center[1] * Math.PI) / 180);
  const r2 = radius * radius;
  return walkers.filter((w) => {
    const dx = (w.position[0] - center[0]) * kx;
    const dy = (w.position[1] - center[1]) * 110_540;
    return dx * dx + dy * dy <= r2;
  });
}

/**
 * Live mode draws the real MBTA and BU feeds. When the day is played back or fast-forwarded,
 * live vehicles can't keep up, so scheduled service on the simulation clock takes over.
 */
function transitSourceAt(transit: Transit, t: number, live: boolean, weekday: number): TransitSource | null {
  if (live) return transit.feed;
  transit.schedule?.setTime(t, weekday);
  return transit.schedule;
}

/** Bikes and empty docks at every BU dock at `target` (sim seconds): live if that's now, else estimated. */
function dockStatusAt({ data, feed }: Bikes, target: number): Map<string, DockEstimate> {
  const now = wallClockSeconds();
  return new Map(data.stations.map((s) => [s.id, estimateDock(s, feed.status(s), data.binSeconds, now, target)]));
}

// Sailboats tack against the shown weather's wind, rounded to 15° so a slowly veering wind doesn't
// re-plan every boat's course on every reading. Westerly until the first weather arrives.
function boatWind(): number | undefined {
  const from = activeWindFromDegrees();
  return from === null ? undefined : Math.round(from / 15) * 15;
}

// Nobody's out sailing in the rain, snow, fog or a storm, or after dark (the Night lighting preset).
// Sailing hours (9:00-19:30) are handled by the boat sim itself.
const NO_SAILING = new Set(['drizzle', 'rain', 'heavy-rain', 'snow', 'fog', 'thunderstorm']);
function sailingWeather(weather: ActiveWeather | null, light: LightPreset): boolean {
  if (light === 'night') return false;
  return !weather || !NO_SAILING.has(weather.condition);
}

function WeatherImpact({ weather }: { weather: ActiveWeather }) {
  const { note, boost } = weatherImpact(weather.condition);
  return (
    <p className="weather-impact">
      <strong>Weather impact:</strong> {note}.
      <span className="muted">
        {weather.sourceLabel}
        {boost > 0 && ` · dining and library occupancy shown +${Math.round(boost * 100)}%; walking routes unchanged`}
      </span>
    </p>
  );
}

// Podium roof for dining halls inside a taller building (Warren Towers' dining is on the 4-storey podium).
const PODIUM_ROOF_M = 16;

/**
 * Building tags, with dining halls that share a building with a dorm given their own tag: Warren
 * Towers shows one "Warren Towers" tag over the middle of all three towers, plus "Warren Dining" on
 * the podium. The dorm tag keeps the dorm's own load; the glow still uses the busier of the two.
 */
function splitSharedTags(
  buildings: BuildingOccupancy[],
  occupancy: Occupancy[],
  footprints: BuildingFootprint[],
  roofHeights: RoofHeights | undefined,
): BuildingOccupancy[] {
  const byBuilding = new Map<string, Occupancy[]>();
  for (const o of occupancy) {
    if (o.location.kind === 'off-campus') continue;
    byBuilding.set(o.location.building, [...(byBuilding.get(o.location.building) ?? []), o]);
  }
  const out: BuildingOccupancy[] = [];
  for (const b of buildings) {
    const places = byBuilding.get(b.id) ?? [];
    const dining = places.filter((o) => o.location.kind === 'dining');
    const rest = places.filter((o) => o.location.kind !== 'dining');
    if (!dining.length || !rest.length) {
      out.push(b);
      continue;
    }
    // The whole building's tag: its centre (over all its parts), named without a part suffix.
    const rings = footprints.filter((f) => f.id === b.id);
    const pts = rings.flatMap((f) => f.polygon);
    const centre: [number, number] = pts.length
      ? [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length]
      : b.position;
    const main = rest.reduce((a, o) => (o.share > a.share ? o : a));
    const count = rest.reduce((a, o) => a + o.count, 0);
    const capacity = rest.reduce((a, o) => a + o.location.capacity, 0);
    const plainName = (name: string) => name.replace(/\s*\([^)]*\)\s*$/, '');
    out.push({ ...b, position: centre, name: plainName(main.location.name), short: plainName(main.location.short), count, capacity, share: main.share });
    for (const d of dining) {
      out.push({
        id: `${b.id}#${d.location.id}`,
        name: d.location.name,
        short: d.location.short,
        position: d.location.position,
        count: d.count,
        capacity: d.location.capacity,
        share: d.share,
        roof: Math.min(PODIUM_ROOF_M, roofHeights?.get(b.id) ?? PODIUM_ROOF_M),
      });
    }
  }
  return out;
}
